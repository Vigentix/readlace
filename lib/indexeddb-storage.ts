export const EXTENSION_DB_NAME = "web-page-translation";
export const EXTENSION_DB_VERSION = 1;
export const EXTENSION_STORE_NAME = "kv";

export interface ExtensionStorage {
  get(key: string): Promise<unknown>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  getByPrefix(prefix: string): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
  setMany(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(EXTENSION_DB_NAME, EXTENSION_DB_VERSION);
    let blocked = false;

    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(EXTENSION_STORE_NAME))
        request.result.createObjectStore(EXTENSION_STORE_NAME);
    });
    request.addEventListener("blocked", () => {
      blocked = true;
      reject(
        new DOMException("IndexedDB upgrade is blocked", "InvalidStateError"),
      );
    });
    request.addEventListener("error", () => {
      reject(
        request.error ??
          new DOMException("Could not open IndexedDB", "UnknownError"),
      );
    });
    request.addEventListener("success", () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      const forget = () => {
        if (databasePromise === opening) databasePromise = undefined;
      };
      database.addEventListener("versionchange", () => {
        database.close();
        forget();
      });
      database.addEventListener("close", forget);
      resolve(database);
    });
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

async function startTransaction(mode: IDBTransactionMode) {
  const opened = openDatabase();
  const database = await opened;
  try {
    return database.transaction(EXTENSION_STORE_NAME, mode);
  } catch (error) {
    if ((error as { name?: unknown })?.name !== "InvalidStateError")
      throw error;
    if (databasePromise === opened) databasePromise = undefined;
    return (await openDatabase()).transaction(EXTENSION_STORE_NAME, mode);
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        transaction.error ??
          new DOMException("IndexedDB transaction failed", "UnknownError"),
      );
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", fail, { once: true });
    transaction.addEventListener("error", fail, { once: true });
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () =>
        reject(
          request.error ??
            new DOMException("IndexedDB request failed", "UnknownError"),
        ),
      { once: true },
    );
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const transaction = await startTransaction(mode);
  const done = transactionDone(transaction);
  try {
    const result = await operate(transaction.objectStore(EXTENSION_STORE_NAME));
    await done;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted or completed.
    }
    await done.catch(() => undefined);
    throw error;
  }
}

export const extensionStorage: ExtensionStorage = {
  get(key) {
    return transact("readonly", (store) => requestResult(store.get(key)));
  },

  getMany(keys) {
    return transact("readonly", async (store) => {
      const requests = keys.map(
        (key) => [key, requestResult(store.get(key))] as const,
      );
      const entries = await Promise.all(
        requests.map(async ([key, request]) => [key, await request] as const),
      );
      return Object.fromEntries(
        entries.filter((entry) => entry[1] !== undefined),
      );
    });
  },

  getByPrefix(prefix) {
    const result: Record<string, unknown> = {};
    return transact("readonly", (store) => {
      const request = store.openCursor(
        IDBKeyRange.bound(prefix, `${prefix}\uffff`),
      );
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) return;
        result[String(cursor.key)] = cursor.value;
        cursor.continue();
      });
      return result;
    });
  },

  set(key, value) {
    return transact("readwrite", async (store) => {
      await requestResult(store.put(value, key));
    });
  },

  setMany(entries) {
    return transact("readwrite", async (store) => {
      await Promise.all(
        Object.entries(entries).map(([key, value]) =>
          requestResult(store.put(value, key)),
        ),
      );
    });
  },

  remove(keys) {
    return transact("readwrite", async (store) => {
      await Promise.all(keys.map((key) => requestResult(store.delete(key))));
    });
  },
};
