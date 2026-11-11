export declare const SETTINGS_REFUSAL_CODES: readonly ["settings-unparseable", "settings-newer-version", "settings-invalid-value", "settings-busy", "settings-unavailable"];
export type SettingsRefusalCode = (typeof SETTINGS_REFUSAL_CODES)[number];
export declare class SettingsRefusal extends Error {
    readonly code: SettingsRefusalCode;
    readonly name = "SettingsRefusal";
    constructor(code: SettingsRefusalCode, message: string, options?: ErrorOptions);
}
