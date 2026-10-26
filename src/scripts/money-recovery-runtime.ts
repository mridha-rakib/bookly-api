// No application imports: validate launch intent without constructing financial dependencies.
export class MoneyRecoveryLaunchError extends Error {}

export const assertMoneyRecoveryLaunch = (
  environment: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): void => {
  if (environment["BOOKLY_MONEY_RECOVERY_WORKER_ENABLED"] !== "true") {
    throw new MoneyRecoveryLaunchError("Money recovery requires explicit worker enablement");
  }
  if (environment["BOOKLY_MONEY_RECOVERY_SINGLE_WORKER_CONFIRMED"] !== "true") {
    throw new MoneyRecoveryLaunchError(
      "Money recovery requires an operator-confirmed single-worker topology",
    );
  }
  if (environment["NODE_APP_INSTANCE"] !== undefined && environment["NODE_APP_INSTANCE"] !== "0") {
    throw new MoneyRecoveryLaunchError(
      "Money recovery does not support additional process instances",
    );
  }
  if (environment["NODE_UNIQUE_ID"] !== undefined) {
    throw new MoneyRecoveryLaunchError("Money recovery does not support cluster workers");
  }
  if (!environment["MONGODB_URI"]?.trim() || !environment["STRIPE_SECRET_KEY"]?.trim()) {
    throw new MoneyRecoveryLaunchError(
      "Money recovery requires explicit database and provider configuration",
    );
  }
  if (args.length > 1 || args.some((arg) => arg !== "--once")) {
    throw new MoneyRecoveryLaunchError("Money recovery accepts only the optional --once argument");
  }
};

type Signal = "SIGINT" | "SIGTERM";
type SignalSource = {
  once: (signal: Signal, listener: () => void) => unknown;
  removeListener: (signal: Signal, listener: () => void) => unknown;
};

export const withMoneyRecoveryLifecycle = async (options: {
  signals: SignalSource;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  execute: (
    shouldStop: () => boolean,
    wait: (milliseconds: number) => Promise<void>,
  ) => Promise<void>;
  onStopping: () => void;
}): Promise<void> => {
  let stopping = false;
  let releaseWait: (() => void) | undefined;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    releaseWait?.();
    options.onStopping();
  };
  const wait = (milliseconds: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopping) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        releaseWait = undefined;
        resolve();
      }, milliseconds);
      releaseWait = () => {
        clearTimeout(timeout);
        releaseWait = undefined;
        resolve();
      };
    });

  options.signals.once("SIGINT", shutdown);
  options.signals.once("SIGTERM", shutdown);
  try {
    await options.connect();
    if (!stopping) await options.execute(() => stopping, wait);
  } finally {
    releaseWait?.();
    try {
      await options.disconnect();
    } finally {
      options.signals.removeListener("SIGINT", shutdown);
      options.signals.removeListener("SIGTERM", shutdown);
    }
  }
};
