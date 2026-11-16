import type { ProviderId } from "../types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import type { ProviderAdapter } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export type { ProviderAdapter, ProviderInput, CheckResult } from "./types";
export { ProviderError } from "./types";
