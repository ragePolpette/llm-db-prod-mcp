export async function runWithTimeout(promiseFactory, timeoutMs, label) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);

    try {
        return await Promise.race([
            promiseFactory(abortController.signal),
            new Promise((_, reject) => {
                abortController.signal.addEventListener(
                    "abort",
                    () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
                    { once: true }
                );
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
}
