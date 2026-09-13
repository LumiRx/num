export declare function dayShift(departs?: string | null, arrives?: string | null): number;
export declare function legWindow(
  leg?: { segments: Array<{ departs: string; arrives: string }> } | null,
): string;
export declare function heldFor(validUntil?: string | null, now?: number): string;
export declare function duration(mins?: number | null): string;
export declare const stopsLabel: (stops?: number | null) => string;
