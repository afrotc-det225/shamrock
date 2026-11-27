import {createRemoteJWKSet,jwtVerify} from "jose";
import {PanelError} from "../errors.mjs";
import {boundedJson} from "./http.mjs";

const repo="afrotc-det225/shamrock-staging-runner";
const issuer="https://token.actions.githubusercontent.com";
const keys=createRemoteJWKSet(new URL(issuer+"/.well-known/jwks"));
const audience="shamrock-staging-repository-tests";
const day=86400000;
const prefix="repository-test/";
const uuid=/^[0-9a-f-]{36}$/;
export function runnerIdentity(claims){
  if(claims.repository_id!=="1473995318" || claims.repository_owner_id!=="261806974" ||
     claims.workflow_ref!==repo+"/.github/workflows/check.yml@refs/heads/main" ||
     claims.ref!=="refs/heads/main" || !["schedule","workflow_dispatch"].includes(claims.event_name) ||
     !/^\d+$/.test(claims.run_id) || !/^\d+$/.test(claims.run_attempt))throw new Error("Unexpected runner");
  return claims.run_id+"/"+claims.run_attempt;
}
export async function runnerOperation(request,operation){
  try{
    const token=request.headers.get("authorization")?.match(/^Bearer ([\w.-]+)$/)?.[1];
    const {payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:["RS256"]});
    const run=runnerIdentity(payload);
    if(operation==="claim")return {operation,run};
    const {id,passed}=await boundedJson(request,256);
    if(!uuid.test(id) || typeof passed!=="boolean")throw new Error();
    return {operation,run,id,passed};
  }catch{throw new PanelError("FORBIDDEN","The test runner or its result could not be verified.",403);}
}
export async function repositoryJob(storage,input,now){
  return storage.transaction(async tx=>{
    const {operation,id,run}=input;
    if(operation==="status"){
      const job=await tx.get(prefix+id);
      if(!job || now-job.at>7*day)return null;
      if(["running","publishing"].includes(job.state) && now-job.started>35*60000 || job.state==="queued" && now-job.at>day)return {state:"expired"};
      if(job.state==="passed" && input.currentCommit){
        if((job.patch.edits ?? [job.patch]).some(edit=>edit.path.startsWith("apps/google-adapter/")))return {state:"native"};
        if(job.patch.commit!==input.currentCommit)return {state:"outdated"};
      }
      return {state:job.state};
    }
    const records=await tx.list({prefix});
    const jobs=[];
    for(const [key,job] of records){
      if(now-job.at>7*day){await tx.delete(key);continue;}
      if(["running","publishing"].includes(job.state) && now-job.started>35*60000 || job.state==="queued" && now-job.at>day){
        job.state="expired";await tx.put(key,job);
      }
      jobs.push(job);
    }
    if(operation==="create"){
      if(jobs.filter(j=>now-j.at<day).length>=20)return null;
      const job={id,at:now,state:"queued",patch:input.patch};
      await tx.put(prefix+id,job);return id;
    }
    if(operation==="claim"){
      const publishing=jobs.some(j=>j.state==="publishing");
      const job=jobs.find(j=>["running","publishing"].includes(j.state) && j.run===run)
        ?? jobs.find(j=>j.state==="queued" || (j.state==="approved" && !publishing));
      if(!job)return null;
      if(["queued","approved"].includes(job.state)){
        Object.assign(job,{run,state:job.state==="approved"?"publishing":"running",started:now});await tx.put(prefix+job.id,job);
      }
      return {id:job.id,patch:job.patch,operation:job.state==="publishing"?(job.websiteRelease?"release":"publish"):"test"};
    }
    const job=jobs.find(j=>j.id===id);
    if(!job)return null;
    if(operation==="release" && job.state==="passed" && job.patch){
      const edits=job.patch.edits ?? [job.patch];
      if(edits.some(edit=>edit.path.startsWith("apps/google-adapter/")))return {state:"native"};
      if(job.patch.commit!==input.currentCommit)return {state:"outdated"};
      job.websiteRelease=true;
      job.state="approved";await tx.put(prefix+id,job);
    }
    if(operation==="approve" && job.state==="passed" && job.patch){
      job.state="approved";await tx.put(prefix+id,job);
    }
    if(operation==="finish" && job.run===run && job.state==="publishing"){
      job.state=input.passed?(job.websiteRelease?"live":"published"):(job.websiteRelease?"release_failed":"passed");await tx.put(prefix+id,job);
    }else if(operation==="finish" && job.run===run && job.state==="running"){
      job.state=input.passed?"passed":"failed";if(!input.passed)delete job.patch;await tx.put(prefix+id,job);
    }
    return {state:job.state};
  });
}
export async function wakeRunner(env){
  if(!env.STAGING_RUNNER_DISPATCH)return "scheduled";
  try{
    const response=await fetch("https://api.github.com/repos/"+repo+"/actions/workflows/check.yml/dispatches",{
      method:"POST",redirect:"manual",signal:AbortSignal.timeout(10000),headers:{
        authorization:"Bearer "+env.STAGING_RUNNER_DISPATCH,"user-agent":"SHAMROCK-staging",
        "content-type":"application/json"},body:JSON.stringify({ref:"main"})});
    return response.ok ? "dispatched" : "scheduled (GitHub "+response.status+")";
  }catch{ return "scheduled (dispatch unavailable)"; }
}
