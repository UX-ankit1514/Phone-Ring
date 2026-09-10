import type { PhoneRequestStatus, TargetPublicState } from "@arnifi/contracts";
import { useEffect } from "react";
import type { RequestUiState, RingSubmissionResult } from "./usePhoneRequest";

interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

interface WebMcpDocument extends Document {
  readonly modelContext?: ModelContext;
}

interface Options {
  enabled: boolean;
  canRing: boolean;
  uiState: RequestUiState;
  target: TargetPublicState | null;
  ring: () => Promise<RingSubmissionResult>;
}

/** Exposes the visible primary action to browsers implementing the WebMCP proposal. */
export function usePhoneBellWebMcp({ enabled, canRing, uiState, target, ring }: Options) {
  useEffect(() => {
    const modelContext = (document as WebMcpDocument).modelContext;
    if (!enabled || !modelContext?.registerTool) return;

    const lifecycle = new AbortController();
    const register = modelContext.registerTool.bind(modelContext);

    void Promise.resolve(
      register(
        {
          name: "get_uae_phone_status",
          title: "Get UAE phone status",
          description: "Read whether Arnifi's shared UAE calling phone can receive a request right now.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute: () => ({
            deviceId: target?.deviceId ?? null,
            deviceName: target?.displayName ?? null,
            health: target?.health ?? "unknown",
            availability: target?.availability ?? "unknown",
            requestStatus: uiState,
            canRing,
          }),
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    void Promise.resolve(
      register(
        {
          name: "create_uae_phone_request",
          title: "Ring the UAE phone",
          description: "Immediately send one phone-location request to Arnifi's shared UAE calling phone.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute() {
            if (!canRing) throw new Error("The UAE phone cannot receive a new request right now.");
            const result = await ring();
            if (!result.submitted) throw new Error(`${result.code}: ${result.message}`);
            return {
              requestId: result.requestId,
              status: result.status as PhoneRequestStatus,
              targetDeviceId: target?.deviceId ?? null,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, [canRing, enabled, ring, target, uiState]);
}
