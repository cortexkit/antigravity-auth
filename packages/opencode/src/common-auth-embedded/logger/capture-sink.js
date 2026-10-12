export function createCaptureSink() {
    const records = [];
    const sink = (record) => {
        records.push(record);
    };
    return {
        records,
        sink,
        clear: () => {
            records.length = 0;
        },
    };
}
