import {localStatus,apiUrl} from './setup.mjs';
const c=localStatus(); const r=await fetch(apiUrl+'/auth/v1/settings',{headers:{apikey:c.ANON_KEY}}); const s=await r.json(); console.log(JSON.stringify({status:r.status,emailProviderEnabled:s.external?.email,disableSignup:s.disable_signup}));
