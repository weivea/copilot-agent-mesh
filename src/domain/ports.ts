export interface Clock {
	now(): Date;
}

export interface IdGenerator {
	next(): string;
}

export interface StateStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
}

export const systemClock: Clock = {
	now: () => new Date(),
};
