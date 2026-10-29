(async()=>{
const root=document.getElementById('document'),text=(tag,value,cls='')=>{const n=document.createElement(tag);n.textContent=value;n.className=cls;return n;};
document.getElementById('document-print').onclick=()=>window.print();
try{
 const params=new URLSearchParams(location.search),id=params.get('item'),kind=params.get('kind');
 if(!id)throw Error('Choose a message from your Inbox.');
 const auth=await fetch('/api/terminal-auth');if(!auth.ok)throw Error('Could not connect to Agent Desk.');const {token}=await auth.json();
 const paths={automation:'/api/special-agents',worker:'/api/coordinator-events?task='+encodeURIComponent(id),workflow:'/api/workflows',session:'/api/agents',pr:'/api/pull-requests'};
 if(!paths[kind])throw Error('Unknown report type.');
 const response=await fetch(paths[kind],{headers:{'X-Agent-Desk-Terminal':token}});if(!response.ok)throw Error('This report is unavailable. Open Agent Desk and try again.');const data=await response.json();let item;
 if(kind==='automation')item=[...(data.inbox||[]),...(data.inbox||[]).flatMap(i=>i.findings||[])].find(i=>i.id===id);
 if(kind==='worker'){const t=(data.tasks||[]).find(t=>t.id===id);if(t)item={title:t.task,detail:t.result||'No report yet.',created:t.updated};}
 if(kind==='workflow'){const t=(data.executions||[]).find(t=>t.id===id);if(t)item={title:(data.configs||[]).find(c=>c.id===t.config_id)?.name||'Workflow report',detail:t.detail,created:t.finished||t.created};}
 if(kind==='pr')item=(data.events||[]).find(t=>t.id===id);
 if(kind==='session'){const t=(data.agents||[]).find(t=>t.id===id);if(t)item={title:t.name,detail:t.question||'This session has no current response request.',created:t.updated};}
 if(!item)throw Error('This message is no longer available.');
 root.replaceChildren(text('p','AGENT DESK / INBOX','document-kicker'),text('h1',item.title));document.title=item.title+' · Agent Desk';
 if(item.created)root.append(text('p',new Date(item.created*1000).toLocaleString(),'document-meta'));
 const body=text('article','','inbox-body');window.renderDeskDocument(body,item.detail||'');root.append(body);
 for(const finding of item.findings||[]){const section=text('section','','document-evidence');section.append(text('h2',finding.title));const content=text('article','','inbox-body');window.renderDeskDocument(content,finding.detail);section.append(content);if(/^https?:\/\//.test(finding.url||'')){const a=text('a','View source ↗');a.href=finding.url;a.target='_blank';a.rel='noopener noreferrer';section.append(a);}root.append(section);}
 if(/^https?:\/\//.test(item.url||'')){const a=text('a','View source ↗');a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';root.append(a);}
}catch(error){root.replaceChildren(text('h1','Unable to open report'),text('p',error.message));}
})();
