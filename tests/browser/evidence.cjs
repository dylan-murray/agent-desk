// Screenshots from browser checks land in AGENT_DESK_EVIDENCE_DIR, or the system temp dir.
const os=require('node:os'),path=require('node:path');
module.exports=name=>path.join(process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir(),name);
