# Staging Google authorization

The standalone staging adapter requires renewed SHAMROCK-account consent when this manifest change is uploaded. This changes the staging script's requested OAuth scopes only; it does not authorize production mutations, alter sharing, enable a processing gate, or purchase a service.

The explicit scope changes are:

- `drive.readonly` → `drive`: the native frontend publisher and managed Forms host must update their existing, automation-owned private JSON checkpoints. Those files were provisioned through a different OAuth client, so `drive.file` alone does not establish access to them.
- `forms.body.readonly` → `forms.body`: publish choices in existing questions without rebuilding Forms or changing their IDs.
- Add `forms.responses.readonly`: reread the actual native response, including its verified responder and last-submitted revision.

The existing Apps Script `forms`, Sheets, trigger-management, external-request and account-identity scopes remain. Full Drive authorization also qualifies for the Forms REST methods; the explicit Forms scopes document their separate required capabilities. The runtime still limits operations to exact reviewed staging resources with verified ownership and private sharing.

Before resuming a publisher after a scope failure, keep its local gate paused and both spreadsheet edit fences intact. Inspect the retained claim and private checkpoint, compare actual provider state with its frozen before/after plan, and resolve any expired lease explicitly. Do not reset journals, recreate a claim, replay content or release protections merely because consent has succeeded. A command-line bootstrap using gcloud credentials does not demonstrate that the Apps Script token can write the same file.

After uploading the committed staging manifest, authorize a safe read/status function under the intended SHAMROCK account. Verify the new consent completed, then perform a controlled private-checkpoint write/readback and retained-plan recovery in staging before declaring native publication functional. Source tests cannot prove OAuth grants or live provider behavior.

Provider references: [Drive files.update scopes](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update), [Forms batchUpdate scopes and revision control](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate), [native response reads](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/get).
