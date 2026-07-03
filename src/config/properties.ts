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
    V2_TRANSITION_DRAFT: 'V2_TRANSITION_DRAFT',
    V2_TRANSITION_STATE: 'V2_TRANSITION_STATE',
    V2_BACKEND_ARCHIVES: 'V2_BACKEND_ARCHIVES',
  } as const;

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
    { key: PROPERTY_KEYS.V2_TRANSITION_DRAFT, description: 'Internal resumable draft for the v2 semester/year transition wizard.' },
    { key: PROPERTY_KEYS.V2_TRANSITION_STATE, description: 'Internal resumable execution state for an applied v2 semester/year transition.' },
    { key: PROPERTY_KEYS.V2_BACKEND_ARCHIVES, description: 'Internal registry of temporary backend transition archives pending deletion.' },
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
    return scriptProperties().getProperty(key) || '';
  }

  export function setScriptProperty(key: string, value: string) {
    const props = scriptProperties();
    if (value) props.setProperty(key, value);
    else props.deleteProperty(key);
  }

  export function deleteScriptProperty(key: string) {
    scriptProperties().deleteProperty(key);
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

}
