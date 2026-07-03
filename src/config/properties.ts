// Configuration helpers for Script Properties and resource naming.

namespace Config {
  export const PROPERTY_KEYS = {
    MAIN_SPREADSHEET_ID: 'MAIN_SPREADSHEET_ID',
    ADMIN_SPREADSHEET_ID: 'ADMIN_SPREADSHEET_ID',
    ATTENDANCE_FORM_ID: 'ATTENDANCE_FORM_ID',
    EXCUSAL_REQUEST_FORM_ID: 'EXCUSAL_REQUEST_FORM_ID',
    CADET_DIRECTORY_FORM_ID: 'CADET_DIRECTORY_FORM_ID',
    EXCUSAL_MANAGEMENT_SPREADSHEET_ID: 'EXCUSAL_MANAGEMENT_SPREADSHEET_ID',
    MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS: 'MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS',
    DISABLE_MAIN_WORKBOOK_FORMATTING: 'DISABLE_MAIN_WORKBOOK_FORMATTING',
    DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS: 'DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS',
    AUTOMATIONS_PAUSED: 'AUTOMATIONS_PAUSED',
  } as const;

  const LEGACY_PROPERTY_KEYS: Record<string, string[]> = {
    [PROPERTY_KEYS.MAIN_SPREADSHEET_ID]: ['FRONTEND_SHEET_ID'],
    [PROPERTY_KEYS.ADMIN_SPREADSHEET_ID]: ['BACKEND_SHEET_ID'],
    [PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID]: ['EXCUSALS_FORM_ID'],
    [PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID]: ['DIRECTORY_FORM_ID'],
    [PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID]: ['EXCUSALS_MANAGEMENT_SHEET_ID'],
    [PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS]: ['SHAMROCK_MENU_ALLOWED_EMAILS'],
    [PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING]: ['DISABLE_FRONTEND_FORMATTING'],
    [PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS]: ['DISABLE_FRONTEND_COLUMN_WIDTHS'],
    [PROPERTY_KEYS.AUTOMATIONS_PAUSED]: ['FRONTEND_SYNC_PAUSED'],
  };

  export const SCRIPT_PROPERTY_HELP = [
    { key: PROPERTY_KEYS.MAIN_SPREADSHEET_ID, description: 'Google Sheet ID for the main user-facing SHAMROCK workbook.' },
    { key: PROPERTY_KEYS.ADMIN_SPREADSHEET_ID, description: 'Google Sheet ID for the admin/source-of-truth SHAMROCK workbook.' },
    { key: PROPERTY_KEYS.ATTENDANCE_FORM_ID, description: 'Google Form ID for attendance submissions.' },
    { key: PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID, description: 'Google Form ID for cadet excusal requests.' },
    { key: PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID, description: 'Google Form ID for cadet directory updates.' },
    { key: PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID, description: 'Google Sheet ID for the excusal decision management workbook.' },
    { key: PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS, description: 'Comma-separated emails allowed to edit protected areas in the main workbook, in addition to leadership-derived editors.' },
    { key: PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING, description: 'Set to true to stop SHAMROCK from applying main workbook visual formatting.' },
    { key: PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS, description: 'Set to true to stop SHAMROCK from changing main workbook column widths.' },
    { key: PROPERTY_KEYS.AUTOMATIONS_PAUSED, description: 'Internal pause flag set by the SHAMROCK Pause automations menu action.' },
  ];

  export const RESOURCE_NAMES = {
    FRONTEND_SPREADSHEET: 'SHAMROCK Frontend',
    BACKEND_SPREADSHEET: 'SHAMROCK Backend',
    ATTENDANCE_FORM: 'SHAMROCK Attendance Form',
    EXCUSALS_FORM: 'SHAMROCK Excusals Form',
    DIRECTORY_FORM: 'SHAMROCK Directory Form',
    ATTENDANCE_FORM_SHEET: 'Attendance Form Responses',
    EXCUSALS_FORM_SHEET: 'Excusals Form Responses',
    DIRECTORY_FORM_SHEET: 'Directory Form Responses',
  } as const;

  export function scriptProperties(): GoogleAppsScript.Properties.Properties {
    return PropertiesService.getScriptProperties();
  }

  export function getScriptProperty(key: string): string {
    const props = scriptProperties();
    const current = props.getProperty(key) || '';
    const legacyKeys = LEGACY_PROPERTY_KEYS[key] || [];

    if (current) {
      legacyKeys.forEach((legacyKey) => props.deleteProperty(legacyKey));
      return current;
    }

    for (const legacyKey of legacyKeys) {
      const legacyValue = props.getProperty(legacyKey) || '';
      if (legacyValue) {
        props.setProperty(key, legacyValue);
        props.deleteProperty(legacyKey);
        Log.info(`Migrated script property ${legacyKey} -> ${key}`);
        return legacyValue;
      }
      props.deleteProperty(legacyKey);
    }

    return '';
  }

  export function setScriptProperty(key: string, value: string) {
    const props = scriptProperties();
    if (value) props.setProperty(key, value);
    else props.deleteProperty(key);

    (LEGACY_PROPERTY_KEYS[key] || []).forEach((legacyKey) => props.deleteProperty(legacyKey));
  }

  export function deleteScriptProperty(key: string) {
    const props = scriptProperties();
    props.deleteProperty(key);
    (LEGACY_PROPERTY_KEYS[key] || []).forEach((legacyKey) => props.deleteProperty(legacyKey));
  }

  export function getBooleanScriptProperty(key: string): boolean {
    return getScriptProperty(key).toLowerCase() === 'true';
  }

  export function setBooleanScriptProperty(key: string, enabled: boolean) {
    setScriptProperty(key, enabled ? 'true' : '');
  }

  export function getCommaSeparatedScriptProperty(key: string): string[] {
    return getScriptProperty(key)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  export function migrateLegacyScriptProperties() {
    Object.keys(LEGACY_PROPERTY_KEYS).forEach((key) => {
      getScriptProperty(key);
    });
  }
}
