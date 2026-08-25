export interface SecretStore {
	get(key: string): Promise<string | undefined>;
	store(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
	private readonly values = new Map<string, string>();

	public async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}

	public async store(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	public async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}
