/**
 * Deterministic Keyed Mutex Service
 * 
 * Solves two critical concurrency challenges:
 * 1. Race conditions: Concurrent requests operating on the same account are serialized.
 * 2. Deadlocks: When a transaction touches multiple accounts (e.g., A -> B vs B -> A),
 *    locks are ALWAYS acquired in canonical lexicographical order (Dijkstra resource hierarchy).
 */

class LockService {
  constructor() {
    // Map of key -> Promise queue tail
    this.queues = new Map();
  }

  /**
   * Acquire a lock on a single key.
   * Returns an unlock function.
   */
  async acquire(key) {
    let release;
    const nextLock = new Promise((resolve) => {
      release = resolve;
    });

    const currentLock = this.queues.get(key) || Promise.resolve();
    this.queues.set(key, currentLock.then(() => nextLock));

    await currentLock;

    let unlocked = false;
    return () => {
      if (!unlocked) {
        unlocked = true;
        release();
        // Clean up memory if no other lock is waiting
        if (this.queues.get(key) === currentLock.then(() => nextLock)) {
          this.queues.delete(key);
        }
      }
    };
  }

  /**
   * Acquire locks on multiple keys in canonical sorted order to guarantee zero deadlocks.
   * Returns an unlockAll function.
   */
  async acquireMany(keys) {
    // Filter duplicates and sort deterministically
    const uniqueSortedKeys = [...new Set(keys.filter(Boolean))].sort();
    const releases = [];

    for (const key of uniqueSortedKeys) {
      const release = await this.acquire(key);
      releases.push(release);
    }

    let allUnlocked = false;
    return () => {
      if (!allUnlocked) {
        allUnlocked = true;
        // Release in reverse order
        for (let i = releases.length - 1; i >= 0; i--) {
          releases[i]();
        }
      }
    };
  }

  /**
   * Execute an async critical section with locks on the specified accounts.
   */
  async withLocks(keys, callback) {
    const unlock = await this.acquireMany(keys);
    try {
      return await callback();
    } finally {
      unlock();
    }
  }
}

const lockService = new LockService();

module.exports = lockService;
