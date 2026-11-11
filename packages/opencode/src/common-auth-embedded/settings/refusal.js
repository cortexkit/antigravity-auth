export const SETTINGS_REFUSAL_CODES = Object.freeze([
    'settings-unparseable',
    'settings-newer-version',
    'settings-invalid-value',
    'settings-busy',
    'settings-unavailable',
]);
export class SettingsRefusal extends Error {
    code;
    name = 'SettingsRefusal';
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
    }
}
