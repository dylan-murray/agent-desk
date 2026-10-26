function restoreBounds(saved, displays) {
  const candidate = {x: Number(saved.x), y: Number(saved.y), width: Number(saved.width) || 1280, height: Number(saved.height) || 850};
  const area = displays.find(({workArea: a}) => candidate.x < a.x+a.width && candidate.x+candidate.width > a.x && candidate.y < a.y+a.height && candidate.y+candidate.height > a.y)?.workArea || displays[0].workArea;
  const width = Math.min(area.width, Math.max(480, candidate.width));
  const height = Math.min(area.height, Math.max(400, candidate.height));
  return {width, height, x: Math.max(area.x, Math.min(Number.isFinite(candidate.x) ? candidate.x : area.x+(area.width-width)/2, area.x+area.width-width)), y: Math.max(area.y, Math.min(Number.isFinite(candidate.y) ? candidate.y : area.y+(area.height-height)/2, area.y+area.height-height))};
}
module.exports = {restoreBounds};
