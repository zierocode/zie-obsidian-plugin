export async function retry<T>(fn: () => Promise<T>, maxAttempts: number = 5, baseDelayMs: number = 1000): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt === maxAttempts) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('unreachable');
}
