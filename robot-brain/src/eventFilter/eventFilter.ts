import { AetherEvent } from "./event";
import { EventQueue } from "./eventQueue";
import { DuplicateFilter } from "./duplicateFilter";
import { Logger } from "../utils/logger";

type EventListener = (event: AetherEvent) => void;

export class EventFilter {
    private queue: EventQueue;
    private duplicateFilter: DuplicateFilter;
    private listeners: Set<EventListener> = new Set();

    constructor() {
        this.queue = new EventQueue();
        this.duplicateFilter = new DuplicateFilter();
    }

    publish(event: AetherEvent): void {
        const normalized: AetherEvent = {
            ...event,
            timestamp: event.timestamp || Date.now()
        };

        if (this.duplicateFilter.isDuplicate(normalized)) {
            Logger.info("EVENT FILTER", {
                "Event": "Event rejected (duplicate)",
                "Type": normalized.type,
                "Source": normalized.source,
                "Queue size": this.queue.size()
            });
            return;
        }

        this.queue.enqueue(normalized);

        Logger.info("EVENT FILTER", {
            "Event": "Event accepted",
            "Type": normalized.type,
            "Source": normalized.source,
            "Queue size": this.queue.size()
        });

        for (const listener of this.listeners) {
            listener(normalized);
        }
    }

    subscribe(listener: EventListener): void {
        this.listeners.add(listener);
    }

    unsubscribe(listener: EventListener): void {
        this.listeners.delete(listener);
    }

    getQueue(): EventQueue {
        return this.queue;
    }

    clear(): void {
        this.queue.clear();
        this.duplicateFilter.clear();
        this.listeners.clear();
    }
}
