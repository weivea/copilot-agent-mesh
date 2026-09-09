package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const maxFrameBytes = 1024 * 1024

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	createJobObject           = kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject   = kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject  = kernel32.NewProc("AssignProcessToJobObject")
	terminateJobObject        = kernel32.NewProc("TerminateJobObject")
	queryInformationJobObject = kernel32.NewProc("QueryInformationJobObject")
	resumeThread              = kernel32.NewProc("ResumeThread")
	initializeAttributes      = kernel32.NewProc("InitializeProcThreadAttributeList")
	updateAttributes          = kernel32.NewProc("UpdateProcThreadAttribute")
	deleteAttributes          = kernel32.NewProc("DeleteProcThreadAttributeList")
)

type request struct {
	Type           string            `json:"type"`
	ID             int               `json:"id"`
	Executable     string            `json:"executable"`
	Args           []string          `json:"args"`
	Environment    map[string]string `json:"environment"`
	Cwd            string            `json:"cwd"`
	MaxOutputBytes int64             `json:"maxOutputBytes"`
}

type basicLimit struct {
	ProcessTime, JobTime int64
	Flags                uint32
	Minimum, Maximum     uintptr
	ActiveProcesses      uint32
	Affinity             uintptr
	Priority, Scheduling uint32
}

type extendedLimit struct {
	Basic                                                      basicLimit
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

type startupInfoEx struct {
	syscall.StartupInfo
	Attributes uintptr
}

type ownedJob struct {
	mu       sync.Mutex
	job      syscall.Handle
	process  syscall.Handle
	pid      uint32
	assigned bool
}

type flushRequest struct {
	done chan struct{}
}

func main() {
	if code, sentinel := runSentinelIfRenamed(); sentinel {
		os.Exit(code)
	}
	// A blocked protocol consumer must never block parent-disconnect cleanup.
	events := make(chan any, 32)
	fatal := make(chan string, 1)
	reportFatal := func(code string) {
		select {
		case fatal <- code:
		default:
		}
	}
	go func() {
		encoder := json.NewEncoder(os.Stdout)
		for event := range events {
			if flush, ok := event.(flushRequest); ok {
				close(flush.done)
				continue
			}
			if encoder.Encode(event) != nil {
				reportFatal("control_write_failed")
				return
			}
		}
	}()
	send := func(event any) {
		select {
		case events <- event:
		case <-time.After(time.Second):
			reportFatal("control_backpressure")
		}
	}
	requests := make(chan request)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), maxFrameBytes)
		scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
			if end := bytes.IndexByte(data, '\n'); end >= 0 {
				return end + 1, data[:end], nil
			}
			if atEOF && len(data) > 0 {
				return 0, nil, io.ErrUnexpectedEOF
			}
			return 0, nil, nil
		})
		for scanner.Scan() {
			var r request
			if json.Unmarshal(scanner.Bytes(), &r) != nil {
				reportFatal("invalid_control_frame")
				return
			}
			select {
			case requests <- r:
			case <-time.After(10 * time.Second):
				reportFatal("control_timeout")
				return
			}
		}
		reportFatal("control_disconnected")
	}()
	var job *ownedJob
	exited := make(chan uint32, 1)
	var readers sync.WaitGroup
	for {
		select {
		case r := <-requests:
			switch r.Type {
			case "start":
				if job != nil {
					reportFatal("already_started")
					continue
				}
				var err error
				job, err = launch(r, send, reportFatal, &readers)
				if err != nil {
					// Never echo a command, environment, path, or child output in errors.
					confirmed := job == nil || job.stop() == nil
					send(map[string]any{"type": "error", "id": r.ID, "code": "launch_failed", "cleanupConfirmed": confirmed})
					if !confirmed {
						continue
					}
					flushAndExit(events, 1)
				}
				send(map[string]any{"type": "started", "id": r.ID, "pid": job.pid})
				go func(owned *ownedJob) {
					syscall.WaitForSingleObject(owned.process, syscall.INFINITE)
					var code uint32
					if syscall.GetExitCodeProcess(owned.process, &code) != nil {
						reportFatal("exit_query_failed")
						return
					}
					exited <- code
				}(job)
			case "pids":
				if job == nil {
					reportFatal("not_started")
					continue
				}
				pids, err := job.pids()
				if err != nil {
					send(map[string]any{"type": "error", "id": r.ID, "code": "job_query_failed"})
				} else {
					send(map[string]any{"type": "pids", "id": r.ID, "pids": pids})
				}
			case "terminate":
				if job != nil && job.stop() != nil {
					send(map[string]any{"type": "error", "id": r.ID, "code": "cleanup_unconfirmed"})
					continue // Retain the exact job handle for an explicit retry.
				}
				waitReaders(&readers)
				send(map[string]any{"type": "stopped", "id": r.ID, "cleanupConfirmed": true})
				flushAndExit(events, 0)
			default:
				reportFatal("unknown_control_request")
			}
		case code := <-exited:
			if job.stop() != nil {
				send(map[string]any{"type": "error", "code": "cleanup_unconfirmed"})
				continue
			}
			if !waitReaders(&readers) {
				send(map[string]any{"type": "error", "code": "output_drain_timeout", "cleanupConfirmed": true})
				flushAndExit(events, 1)
			}
			select {
			case failure := <-fatal:
				send(map[string]any{"type": "error", "code": failure, "cleanupConfirmed": true})
				flushAndExit(events, 1)
			default:
			}
			send(map[string]any{"type": "exit", "code": code, "cleanupConfirmed": true})
			flushAndExit(events, 0)
		case code := <-fatal:
			confirmed := job == nil || job.stop() == nil
			if !confirmed {
				if code == "output_limit" || code == "output_read_failed" || code == "exit_query_failed" {
					send(map[string]any{"type": "error", "code": code, "cleanupConfirmed": false})
					continue
				}
				// Closing the owning job is the final fail-closed fallback, never a PID sweep.
				if job.assigned {
					syscall.CloseHandle(job.job)
				} else {
					// A failed assignment left a suspended process, not a running
					// tree. Never release its exact HANDLE while termination is
					// unconfirmed, even when the parent has already disappeared.
					for job.stop() != nil {
						time.Sleep(time.Second)
					}
					confirmed = true
				}
			}
			send(map[string]any{"type": "error", "code": code, "cleanupConfirmed": confirmed})
			flushAndExit(events, 1)
		}
	}
}

func waitReaders(readers *sync.WaitGroup) bool {
	done := make(chan struct{})
	go func() { readers.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(time.Second):
		return false
	}
}

func flushAndExit(events chan any, code int) {
	// Allow a small bounded drain; process exit closes the kill-on-close job even
	// if Node stopped consuming its pipe. No child inherits that job handle.
	// Producers can still be exiting; do not close their shared channel.
	done := make(chan struct{})
	select {
	case events <- flushRequest{done: done}:
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	case <-time.After(time.Second):
	}
	os.Exit(code)
}

func launch(r request, send func(any), fail func(string), readers *sync.WaitGroup) (*ownedJob, error) {
	if r.Executable == "" || r.MaxOutputBytes <= 0 || r.MaxOutputBytes > 1<<30 {
		return nil, errors.New("invalid start")
	}
	executable, err := syscall.UTF16PtrFromString(r.Executable)
	if err != nil {
		return nil, err
	}
	arguments := append([]string{r.Executable}, r.Args...)
	for i, arg := range arguments {
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("invalid argument")
		}
		arguments[i] = syscall.EscapeArg(arg)
	}
	command, err := syscall.UTF16PtrFromString(strings.Join(arguments, " "))
	if err != nil {
		return nil, err
	}
	env, err := environmentBlock(r.Environment)
	if err != nil {
		return nil, err
	}
	var cwd *uint16
	if r.Cwd != "" {
		cwd, err = syscall.UTF16PtrFromString(r.Cwd)
		if err != nil {
			return nil, err
		}
	}
	jobHandle, _, jobErr := createJobObject.Call(0, 0)
	if jobHandle == 0 {
		return nil, jobErr
	}
	job := &ownedJob{job: syscall.Handle(jobHandle)}
	success := false
	defer func() {
		if !success {
			syscall.CloseHandle(job.job)
		}
	}()
	limits := extendedLimit{}
	limits.Basic.Flags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if ok, _, e := setInformationJobObject.Call(jobHandle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		return nil, e
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer stdoutW.Close()
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		return nil, err
	}
	defer stderrW.Close()
	defer func() {
		if !success {
			stdoutR.Close()
			stderrR.Close()
		}
	}()
	nul, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer nul.Close()
	handles := []syscall.Handle{syscall.Handle(nul.Fd()), syscall.Handle(stdoutW.Fd()), syscall.Handle(stderrW.Fd())}
	for _, handle := range handles {
		if err := syscall.SetHandleInformation(handle, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
			return nil, err
		}
	}
	var size uintptr
	initializeAttributes.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 64*1024 {
		return nil, errors.New("invalid native attribute list size")
	}
	attributes := make([]byte, size)
	ptr := uintptr(unsafe.Pointer(&attributes[0]))
	if ok, _, e := initializeAttributes.Call(ptr, 1, 0, uintptr(unsafe.Pointer(&size))); ok == 0 {
		return nil, e
	}
	defer func() {
		deleteAttributes.Call(ptr)
		// The Windows attribute list retains native pointers beyond the syscall
		// that populates it; uintptr fields are not GC roots.
		runtime.KeepAlive(attributes)
		runtime.KeepAlive(handles)
	}()
	if ok, _, e := updateAttributes.Call(ptr, 0, 0x20002, uintptr(unsafe.Pointer(&handles[0])), uintptr(len(handles))*unsafe.Sizeof(handles[0]), 0, 0); ok == 0 {
		return nil, e
	}
	info := startupInfoEx{Attributes: ptr}
	info.Cb = uint32(unsafe.Sizeof(info))
	info.Flags = syscall.STARTF_USESTDHANDLES
	info.StdInput, info.StdOutput, info.StdErr = handles[0], handles[1], handles[2]
	var process syscall.ProcessInformation
	// CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
	// EXTENDED_STARTUPINFO_PRESENT: assign before any child instruction executes.
	err = syscall.CreateProcess(executable, command, nil, nil, true, 0x08080404, &env[0], cwd, &info.StartupInfo, &process)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(process.Thread)
	job.process, job.pid = process.Process, process.ProcessId
	if ok, _, e := assignProcessToJobObject.Call(jobHandle, uintptr(process.Process)); ok == 0 {
		// No child instruction has run. Retain its exact HANDLE until termination
		// is confirmed, even if assignment failed (for example, nested-job policy).
		success = true
		return job, e
	}
	job.assigned = true
	if result, _, e := resumeThread.Call(uintptr(process.Thread)); result == 0xffffffff {
		success = true
		return job, e
	}
	var outputBytes atomic.Int64
	for stream, pipe := range map[string]*os.File{"stdout": stdoutR, "stderr": stderrR} {
		readers.Add(1)
		go func(stream string, pipe *os.File) {
			defer readers.Done()
			defer pipe.Close()
			buffer := make([]byte, 8192)
			for {
				n, err := pipe.Read(buffer)
				if n > 0 {
					if outputBytes.Add(int64(n)) > r.MaxOutputBytes {
						fail("output_limit")
						return
					}
					send(map[string]any{"type": "output", "stream": stream, "data": base64.StdEncoding.EncodeToString(buffer[:n])})
				}
				if err != nil {
					if err != io.EOF {
						fail("output_read_failed")
					}
					return
				}
			}
		}(stream, pipe)
	}
	success = true
	return job, nil
}

func environmentBlock(environment map[string]string) ([]uint16, error) {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		if key == "" || strings.ContainsAny(key, "=\x00") {
			return nil, errors.New("invalid environment")
		}
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return strings.ToUpper(keys[i]) < strings.ToUpper(keys[j]) })
	result := make([]uint16, 0)
	for _, key := range keys {
		value, err := syscall.UTF16FromString(key + "=" + environment[key])
		if err != nil {
			return nil, err
		}
		result = append(result, value...)
	}
	result = append(result, 0)
	if len(result) == 1 {
		result = append(result, 0)
	}
	return result, nil
}

func (job *ownedJob) pids() ([]uint32, error) {
	// JOBOBJECT_BASIC_PROCESS_ID_LIST: counts followed by pointer-sized PIDs.
	for capacity := 64; capacity <= 65536; capacity *= 2 {
		buffer := make([]uintptr, capacity+2)
		ok, _, err := queryInformationJobObject.Call(uintptr(job.job), 3, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer))*unsafe.Sizeof(buffer[0]), 0)
		if ok == 0 {
			if err == syscall.ERROR_MORE_DATA {
				continue
			}
			return nil, err
		}
		count := *(*uint32)(unsafe.Add(unsafe.Pointer(&buffer[0]), 4))
		if count > uint32(capacity) {
			continue
		}
		pids := make([]uint32, count)
		for i := range pids {
			pids[i] = uint32(buffer[i+1])
		}
		return pids, nil
	}
	return nil, errors.New("job process limit exceeded")
}

func (job *ownedJob) stop() error {
	job.mu.Lock()
	defer job.mu.Unlock()
	if !job.assigned {
		if err := syscall.TerminateProcess(job.process, 1); err != nil {
			if result, _ := syscall.WaitForSingleObject(job.process, 0); result != syscall.WAIT_OBJECT_0 {
				return err
			}
		}
		if result, err := syscall.WaitForSingleObject(job.process, 5000); result != syscall.WAIT_OBJECT_0 {
			return fmt.Errorf("suspended process termination unconfirmed: %v", err)
		}
		return nil
	}
	if ok, _, err := terminateJobObject.Call(uintptr(job.job), 1); ok == 0 {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		pids, err := job.pids()
		if err != nil {
			return err
		}
		if len(pids) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("job termination unconfirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
