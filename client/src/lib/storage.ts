// Local storage on this device. Messages and contacts never leave the device
// except as encrypted gift wraps sent through the relay.
// TODO(native): use expo-secure-store for the key and a database for messages.

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode). The app keeps working in memory.
  }
}
