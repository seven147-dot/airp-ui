// Pure helpers shared by the extension and its regression tests.
export const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

export function assertSafeObject(value) {
    const visit = item => {
        if (!item || typeof item !== "object") return;
        for (const [key, child] of Object.entries(item)) {
            if (unsafeKeys.has(key)) throw new Error(`状态字段不允许使用 ${key}`);
            visit(child);
        }
    };
    visit(value);
    return value;
}

export function validateDelta(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AIRP_STATE 必须是 JSON 对象");
    assertSafeObject(value);
    for (const key of ["events", "knowledge", "exposures", "memories", "relationChanges", "reactions", "actions", "characterRelations", "characterStatus", "npcs", "profileUpdates", "friendships", "social", "privateMessageUpdates", "characterInitializations"]) {
        if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error(`${key} 必须是对象数组`);
    }
    if (value.world !== undefined && (!value.world || typeof value.world !== "object" || Array.isArray(value.world))) throw new Error("world 必须是对象");
    return value;
}

// Append-only lists use compact append operations. Other arrays are replaced intact,
// so deletion/reordering cannot corrupt inverse history or array indexes.
export function diffState(before, after, path = []) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (Array.isArray(before) && Array.isArray(after)) {
        if (after.length >= before.length && before.every((item, i) => JSON.stringify(item) === JSON.stringify(after[i]))) {
            return [{ path, append: clone(after.slice(before.length)) }];
        }
        if (after.length >= before.length && before.every((item, i) => item?.id && item.id === after[i]?.id)) {
            const operations = before.flatMap((item, i) => diffState(item, after[i], [...path, i]));
            if (after.length > before.length) operations.push({ path, append: clone(after.slice(before.length)) });
            return operations;
        }
    } else if (before && after && typeof before === "object" && typeof after === "object") {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !unsafeKeys.has(key)).flatMap(key => diffState(before[key], after[key], [...path, key]));
    }
    return [{ path, ...(after === undefined ? { remove: true } : { value: clone(after) }) }];
}

export function applyPatch(input, operations = [], copy = true) {
    let result = copy ? clone(input) : input;
    for (const op of operations) {
        if (op.path.some(key => unsafeKeys.has(String(key)))) throw new Error("无效历史路径");
        if (!op.path.length) {
            result = op.append ? [...(result ?? []), ...clone(op.append)] : clone(op.value);
            continue;
        }
        let parent = result;
        for (const key of op.path.slice(0, -1)) parent = parent[key] ??= {};
        const key = op.path.at(-1);
        if (op.remove) delete parent[key];
        else if (op.append) parent[key] = [...(parent[key] ?? []), ...clone(op.append)];
        else parent[key] = clone(op.value);
    }
    return result;
}

export function checkpointSnapshot(safety, id, side = "after") {
    if (!id) return clone(safety.historyBaseSnapshot);
    const checkpoints = safety.historyCheckpoints ?? [];
    const lookup = new Map(checkpoints.map(item => [item.id, item]));
    const chain = [], seen = new Set();
    let current = lookup.get(id);
    if (!current) return null;
    if (current[side]) return clone(current[side]); // V13 compatibility
    const target = current;
    while (current) {
        if (seen.has(current.id)) throw new Error("历史检查点循环引用");
        seen.add(current.id);
        chain.unshift(current);
        if (!current.parentId) break;
        current = lookup.get(current.parentId);
        if (!current) return null;
    }
    let result = clone(safety.historyBaseSnapshot);
    for (const checkpoint of chain) {
        if (checkpoint.before) result = clone(checkpoint.before);
        else result = applyPatch(result, checkpoint.bridge ?? [], false);
        if (checkpoint === target && side === "before") return result;
        result = checkpoint.after ? clone(checkpoint.after) : applyPatch(result, checkpoint.patch ?? [], false);
    }
    return result;
}

// Keep headings and endings, with a fair share for every section instead of
// silently dropping calendars, restrictions and closing style rules at the tail.
export function balancedText(text, maxChars) {
    const source = String(text ?? "").trim();
    if (source.length <= maxChars) return source;
    const sections = source.split(/(?=^#{1,6}\s)/m).filter(Boolean);
    const trim = (part, budget) => {
        if (part.length <= budget) return part;
        if (budget <= 22) return part.slice(0, budget);
        const head = Math.floor((budget - 22) * 0.65);
        return `${part.slice(0, head).trimEnd()}\n[…内容按预算节选…]\n${part.slice(-Math.max(1, budget - head - 22)).trimStart()}`;
    };
    const budget = Math.max(1, Math.floor((maxChars - sections.length * 2) / sections.length));
    const result = sections.map(part => trim(part, budget)).join("\n\n");
    return result.length <= maxChars ? result : trim(source, maxChars);
}
