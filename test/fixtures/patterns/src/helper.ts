export function calledAtTopLevel(): number { return 1; }
export function wrapper(): number { return reachedOnlyViaWrapper(); }
export function reachedOnlyViaWrapper(): number { return 2; }
