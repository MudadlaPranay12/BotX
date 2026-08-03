import { EventType } from "./eventTypes";

export interface AetherEvent {
    id: string;
    type: EventType;
    source: string;
    timestamp: number;
    payload: unknown;
}
