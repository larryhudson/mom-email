import * as log from "./log.js";

export type QueueHandler = (emailId: string) => Promise<void>;

/**
 * Simple FIFO queue for processing triggered emails.
 * Processes one at a time, oldest first.
 */
export class ProcessingQueue {
	private queue: string[] = [];
	private processing = false;
	private handler: QueueHandler;
	private maxDepth: number;

	constructor(handler: QueueHandler, maxDepth = 10) {
		this.handler = handler;
		this.maxDepth = maxDepth;
	}

	/**
	 * Enqueue an email ID for processing.
	 * Returns true if enqueued, false if queue is full.
	 */
	enqueue(emailId: string): boolean {
		if (this.queue.length >= this.maxDepth) {
			log.logWarning(`Processing queue full (${this.maxDepth}), discarding email ${emailId}`);
			return false;
		}

		this.queue.push(emailId);
		log.logInfo(`Enqueued email ${emailId} for processing (queue depth: ${this.queue.length})`);

		// Start processing if not already running
		this.process();
		return true;
	}

	/**
	 * Current queue depth.
	 */
	get depth(): number {
		return this.queue.length;
	}

	/**
	 * Whether the queue is currently processing an item.
	 */
	get isProcessing(): boolean {
		return this.processing;
	}

	private async process(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		while (this.queue.length > 0) {
			const emailId = this.queue.shift()!;
			try {
				await this.handler(emailId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.logWarning(`Error processing email ${emailId}`, msg);
			}
		}

		this.processing = false;
	}
}
