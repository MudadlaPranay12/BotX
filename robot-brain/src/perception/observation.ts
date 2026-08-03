import { ObservationType } from "./observationType";

export interface Observation {
    id: string;
    type: ObservationType;
    timestamp: number;
    confidence: number;
    source: string;
    data: Record<string, unknown>;
}
