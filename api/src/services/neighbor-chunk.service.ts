// services/neighborChunk.service.ts

export function addNeighborChunks(
    topChunks: any[],
    allChunks: any[],
    window: number = 1
) {
    const chunkMap = new Map<string, any>();

    allChunks.forEach(chunk => {
        const key = `${chunk.docId}_${chunk.order}`;
        chunkMap.set(key, chunk);
    });

    const result = new Map<number, any>();

    topChunks.forEach(chunk => {
        for (let offset = -window; offset <= window; offset++) {
            const key = `${chunk.docId}_${chunk.order + offset}`;
            const neighbor = chunkMap.get(key);
            if (neighbor) {
                result.set(neighbor.chunkId, neighbor);
            }
        }
    });

    return Array.from(result.values());
}
