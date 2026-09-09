package main

import (
	"encoding/base64"
	"io"
	"os"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestOnlyWhitelistedHandlesAreInherited(t *testing.T) {
	if os.Getenv("MESH_HANDLE_FIXTURE") == "1" {
		handle := func(name string) syscall.Handle {
			value, err := strconv.ParseUint(os.Getenv(name), 10, 64)
			if err != nil {
				os.Exit(30)
			}
			return syscall.Handle(value)
		}
		var written uint32
		if syscall.WriteFile(handle("MESH_CANARY_WRITE"), []byte("spoofed-control"), &written, nil) == nil {
			os.Exit(31)
		}
		var read uint32
		buffer := make([]byte, 32)
		if syscall.ReadFile(handle("MESH_CANARY_READ"), buffer, &read, nil) == nil {
			os.Exit(32)
		}
		var accounting [48]byte
		if ok, _, _ := queryInformationJobObject.Call(uintptr(handle("MESH_CANARY_JOB")), 1, uintptr(unsafe.Pointer(&accounting[0])), uintptr(len(accounting)), 0); ok != 0 {
			os.Exit(33)
		}
		if count, err := os.Stdin.Read(buffer); count != 0 || err != io.EOF {
			os.Exit(34)
		}
		os.Stdout.WriteString("owned-stdout")
		os.Stderr.WriteString("owned-stderr")
		os.Exit(0)
	}

	canaryRead, canaryWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer canaryRead.Close()
	defer canaryWrite.Close()
	canaryJob, _, err := createJobObject.Call(0, 0)
	if canaryJob == 0 {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(syscall.Handle(canaryJob))
	for _, handle := range []syscall.Handle{syscall.Handle(canaryRead.Fd()), syscall.Handle(canaryWrite.Fd()), syscall.Handle(canaryJob)} {
		if err := syscall.SetHandleInformation(handle, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := canaryWrite.WriteString("private-controller-frame"); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan any, 8)
	failures := make(chan string, 8)
	var readers sync.WaitGroup
	job, err := launch(request{
		Executable: executable,
		Args:       []string{"-test.run=^TestOnlyWhitelistedHandlesAreInherited$"},
		Environment: map[string]string{
			"MESH_HANDLE_FIXTURE": "1",
			"MESH_CANARY_READ":    strconv.FormatUint(uint64(canaryRead.Fd()), 10),
			"MESH_CANARY_WRITE":   strconv.FormatUint(uint64(canaryWrite.Fd()), 10),
			"MESH_CANARY_JOB":     strconv.FormatUint(uint64(canaryJob), 10),
			"SYSTEMROOT":          os.Getenv("SYSTEMROOT"),
		},
		MaxOutputBytes: 1024,
	}, func(event any) { events <- event }, func(code string) { failures <- code }, &readers)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(job.job)
	defer syscall.CloseHandle(job.process)
	defer job.stop()
	if result, err := syscall.WaitForSingleObject(job.process, 5000); result != syscall.WAIT_OBJECT_0 {
		t.Fatal("Handle-inheritance fixture did not exit", err)
	}
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(job.process, &exitCode); err != nil || exitCode != 0 {
		t.Fatalf("Child accessed a controller handle or lost its stdio: exit=%d, error=%v", exitCode, err)
	}
	if err := job.stop(); err != nil {
		t.Fatal(err)
	}
	if !waitReaders(&readers) {
		t.Fatal("Child output pipes did not close")
	}
	close(events)
	output := map[string]string{}
	for event := range events {
		frame := event.(map[string]any)
		data, err := base64.StdEncoding.DecodeString(frame["data"].(string))
		if err != nil {
			t.Fatal(err)
		}
		output[frame["stream"].(string)] += string(data)
	}
	if output["stdout"] != "owned-stdout" || output["stderr"] != "owned-stderr" || len(failures) != 0 {
		t.Fatal("Only the intended child output streams should be forwarded")
	}
	canaryWrite.Close()
	canary, err := io.ReadAll(canaryRead)
	if err != nil || string(canary) != "private-controller-frame" {
		t.Fatal("Child read or wrote the controller canary pipe", err)
	}
}

func TestNativeStructures(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Fatal("Only Windows x64 and ARM64 are supported")
	}
	if unsafe.Sizeof(extendedLimit{}) != 144 || unsafe.Sizeof(startupInfoEx{}) != 112 {
		t.Fatal("Windows native structure layout mismatch")
	}
}

func TestEnvironmentBlock(t *testing.T) {
	block, err := environmentBlock(map[string]string{"Z": "世界", "A": "spaces and = signs"})
	if err != nil || len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatal("Environment block must be double NUL terminated")
	}
	if syscall.UTF16ToString(block) != "A=spaces and = signs" {
		t.Fatal("Environment block is not sorted")
	}
	for _, env := range []map[string]string{{"": "bad"}, {"A=B": "bad"}, {"A": "bad\x00value"}} {
		if _, err := environmentBlock(env); err == nil {
			t.Fatal("Invalid environment accepted")
		}
	}
}

func TestOwnedNativeProcess(t *testing.T) {
	if os.Getenv("MESH_NATIVE_FIXTURE") == "1" {
		time.Sleep(time.Minute)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var readers sync.WaitGroup
	job, err := launch(request{
		Executable:     executable,
		Args:           []string{"-test.run=^TestOwnedNativeProcess$"},
		Environment:    map[string]string{"MESH_NATIVE_FIXTURE": "1", "SYSTEMROOT": os.Getenv("SYSTEMROOT")},
		MaxOutputBytes: 1024,
	}, func(any) {}, func(string) {}, &readers)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(job.job)
	defer syscall.CloseHandle(job.process)
	defer job.stop()
	pids, err := job.pids()
	if err != nil || len(pids) != 1 || pids[0] != job.pid {
		t.Fatal("The actual suspended child was not assigned to its owning job", err)
	}
	if err := job.stop(); err != nil {
		t.Fatal(err)
	}
	if err := job.stop(); err != nil {
		t.Fatal("Repeated cleanup must be harmless", err)
	}
	readers.Wait()
}
