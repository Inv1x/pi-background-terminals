/**
 * Optional inter-extension contract implemented by pi-ui-customization.
 * This package works without that extension; events are best-effort hints.
 */
export const UI_CUSTOMIZATION_STATUS_ACTIVATION_EVENT =
	"pi-ui-customization:activate-status";
export const UI_CUSTOMIZATION_STATUS_OPTIONS_EVENT =
	"pi-ui-customization:status-options";

export interface UIStatusActivationEvent {
	readonly key: string;
	readonly sessionId: string;
}

export interface UIStatusOptionsEvent {
	readonly key: string;
	readonly preserveSelectedColors?: boolean;
}
