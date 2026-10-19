/** Provider diagnostics are public room data. Never persist credential fragments. */
export function redactDiagnostic(value:unknown,secrets:readonly (string|undefined)[]=[]):string {
  let text=value instanceof Error?value.message:String(value);
  for(const secret of secrets)if(secret)text=text.split(secret).join('[已隐藏凭据]');
  text=text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi,'[已隐藏认证信息]')
    .replace(/\b(?:sk|sk-proj|sk-ant-api\d*)-[A-Za-z0-9_-]{6,}/g,'[已隐藏凭据]')
    .replace(/\*{3,}[^\s,;"')\]}]*/g,'[已隐藏凭据片段]')
    .replace(/\brequest[_ -]?id["']?\s*[:=]\s*["']?[^\s,"')\]}]+/gi,'request_id: [已隐藏]')
    .replace(/https?:\/\/[^\s<>"')]+/gi,url=>{try{const parsed=new URL(url);parsed.username='';parsed.password='';parsed.search='';parsed.hash='';return parsed.toString();}catch{return '[URL]';}});
  return text.slice(-8000);
}
