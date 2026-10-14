// The WebGL renderer draws terminal text to a canvas, so it is not in the DOM.
// Read xterm's buffer instead, plus the pane's own DOM text for notices and status.
async function paneText(pane){
  return pane.evaluate(node=>{
    const term=paneViews.get(node.dataset.paneId)?.term,lines=[];
    if(term){const buffer=term.buffer.active;for(let i=0;i<buffer.length;i++)lines.push(buffer.getLine(i)?.translateToString(true)??'');}
    return lines.join('\n')+'\n'+node.innerText;
  });
}
module.exports={paneText};
