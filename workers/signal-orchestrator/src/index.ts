type SignalQueueMessage = {
  type: "run_signal";
  requestedAt: string;
};

interface Queue<T> {
  send(message: T): Promise<void>;
}

interface ScheduledEvent {}

interface MessageBatch<T> {
  messages: Array<{
    body: T;
    ack(): void;
    retry(): void;
  }>;
}

interface Env {
  CRON_SECRET: string;
  SIGNAL_QUEUE: Queue<SignalQueueMessage>;
  SIGNAL_RUN_URL: string;
}

async function invokeSignalRun(env: Env) {
  const response = await fetch(env.SIGNAL_RUN_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${env.CRON_SECRET}`,
      "x-signal-trigger": "cloudflare-queue",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Signal run failed with ${response.status}: ${body.slice(0, 300)}`);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env) {
    await env.SIGNAL_QUEUE.send({
      type: "run_signal",
      requestedAt: new Date().toISOString(),
    });
  },

  async queue(batch: MessageBatch<SignalQueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (message.body.type !== "run_signal") {
          message.ack();
          continue;
        }

        await invokeSignalRun(env);
        message.ack();
      } catch (error) {
        console.error("signal-orchestrator: queue message failed:", error);
        message.retry();
      }
    }
  },
};
