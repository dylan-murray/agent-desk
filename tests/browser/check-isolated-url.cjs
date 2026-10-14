const value=process.env.AGENT_DESK_TEST_URL;
let url;
try{url=new URL(value);}catch{}
if(!url||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.port==='4310'){
  console.error('Set AGENT_DESK_TEST_URL to an isolated loopback server, such as http://127.0.0.1:4322/. Never use the live server on 4310.');
  process.exit(1);
}
