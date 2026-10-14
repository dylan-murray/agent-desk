(()=>{
const get=id=>document.getElementById('schedule-'+id),days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
for(const [id,count,start] of [['hour',24,0],['minute',60,0],['weekday',7,0],['monthday',31,1]])for(let i=start;i<start+count;i++){const option=document.createElement('option');option.value=i;option.textContent=id==='weekday'?days[i]:id==='monthday'?i:String(i).padStart(2,'0');get(id).append(option);}
function update(){
 const mode=get('frequency').value,h=get('hour').value,m=get('minute').value,day=get('weekday').value,date=get('monthday').value,custom=mode==='custom';
 get('hour-label').hidden=custom||mode==='hourly';get('minute').parentElement.hidden=custom;get('weekday-label').hidden=mode!=='weekly';get('monthday-label').hidden=mode!=='monthly';get('custom-label').hidden=!custom;
 if(!custom)get('cron').value=`${m} ${mode==='hourly'?'*':h} ${mode==='monthly'?date:'*'} * ${mode==='weekdays'?'1-5':mode==='weekly'?day:'*'}`;
 const time=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
 get('summary').textContent=custom?'Custom schedule · minute, hour, day, month, weekday.':(mode==='hourly'?`Every hour at minute ${String(m).padStart(2,'0')}`:mode==='weekly'?`Every ${days[day]} at ${time}`:mode==='monthly'?`Day ${date} of every month at ${time}${Number(date)>28?' · months without this day are skipped':''}`:mode==='weekdays'?`Monday–Friday at ${time}`:`Every day at ${time}`)+' · '+get('timezone').value;
}
function load(value){
 const parts=value.trim().split(/\s+/),[m,h,d,month,w]=parts;let mode='custom';
 const number=(v,max,min=0)=>/^\d+$/.test(v||'')&&Number(v)>=min&&Number(v)<=max;
 if(parts.length===5&&number(m,59)&&month==='*'){
  if(h==='*'&&d==='*'&&w==='*')mode='hourly';
  else if(number(h,23)){
   if(d==='*'&&w==='*')mode='daily';else if(d==='*'&&w==='1-5')mode='weekdays';else if(d==='*'&&number(w,6))mode='weekly';else if(number(d,31,1)&&w==='*')mode='monthly';
  }
 }
 get('frequency').value=mode;get('hour').value=number(h,23)?Number(h):9;get('minute').value=number(m,59)?Number(m):0;get('weekday').value=number(w,6)?Number(w):1;get('monthday').value=number(d,31,1)?Number(d):1;get('cron').value=value;update();
}
for(const id of ['frequency','hour','minute','weekday','monthday'])get(id).addEventListener('change',update);
get('timezone').addEventListener('input',update);window.scheduleControls={load,refresh:update};
})();
