(() => {
const cfg=window.APP_CONFIG||{};
const sb=window.supabase?.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
const $=id=>document.getElementById(id);
const EMP_TABLE='sewon_employees', CAL_TABLE='sewon_calendar_events', CONTRACT_TABLE='sewon_contract_history', BIRTHDAY_TABLE='sewon_birthday_checks', PHOTO_BUCKET='sewon-employee-photos';
let employees=[], calendarEvents=[], contractHistory=[], birthdayChecks=[], contractRowsByEmployee=new Map(), currentTab='대시보드', currentCompany='전체', docColumnsReady=true, importPlan=null, currentEmployee=null, currentCalendarEvent=null, deferredPrompt=null, calendarTypeFilter='전체', calendarMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1), calendarLoadError='', birthdayCheckError='', calendarRealtime=null;
const fields={site:'site',name:'name',gender:'gender',department:'department',hourly_wage:'hourlyWage',visa:'visa',resident_no:'residentNo',phone:'phone',address:'address',hire_date:'hireDate',handover_date:'handoverDate',termination_date:'terminationDate',bank:'bank',account_no:'accountNo',account_holder:'accountHolder',severance_settlement_date:'severanceDate',annual_leave_settlement_date:'annualLeaveSettlementDate',annual_leave_carryover_days:'annualLeaveCarryoverInput',notes:'notes',work_history:'workHistory',interview_route:'interviewRoute',locker_room:'lockerRoom'};
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function today(){return new Date(new Date().toDateString())}
function parseDate(s){if(!s)return null; const d=new Date(s+'T00:00:00'); return isNaN(d)?null:d}
function daysUntil(s){const d=parseDate(s);if(!d)return null;return Math.ceil((d-today())/86400000)}
function isExitScheduled(e){const d=daysUntil(e.termination_date);return !!e.termination_date&&d!==null&&d>0}
function isTerminated(e){
  const d=daysUntil(e.termination_date);
  if(e.termination_date&&d!==null)return d<=0;
  return e.employment_status==='퇴사';
}
function isExpiring(e){const d=currentContractInfo(e).days;return !isTerminated(e)&&d!==null&&d<=7}
function fmtDate(s){return s||'-'}

function tenureLabel(hireDate){
  const start=parseDate(hireDate);
  const end=today();
  if(!start)return '근속 -';
  if(start>end){
    const d=Math.max(0,Math.ceil((start-end)/86400000));
    return `입사 D-${d}`;
  }
  let y=end.getFullYear()-start.getFullYear();
  let m=end.getMonth()-start.getMonth();
  let d=end.getDate()-start.getDate();
  if(d<0){
    m-=1;
    d+=new Date(end.getFullYear(),end.getMonth(),0).getDate();
  }
  if(m<0){y-=1;m+=12}
  const parts=[];
  if(y>0)parts.push(`${y}년`);
  parts.push(`${m}개월`,`${d}일`);
  return `근속 ${parts.join(' ')}`;
}
function employeeContractRows(employeeId){
  return (contractRowsByEmployee.get(String(employeeId))||[])
    .filter(r=>r&&r.contract_end_date)
    .sort((a,b)=>String(a.contract_start_date||'').localeCompare(String(b.contract_start_date||'')));
}
function currentContractInfo(e){
  const rows=employeeContractRows(e.id);
  const todayKey=localDateKey(new Date());
  let chosen=null;

  const active=rows.filter(r=>
    (!r.contract_start_date||r.contract_start_date<=todayKey) &&
    r.contract_end_date>=todayKey
  ).sort((a,b)=>String(b.contract_start_date||'').localeCompare(String(a.contract_start_date||'')));
  if(active.length)chosen=active[0];

  if(!chosen){
    const future=rows.filter(r=>(r.contract_start_date||r.contract_end_date)>todayKey)
      .sort((a,b)=>String(a.contract_start_date||a.contract_end_date).localeCompare(String(b.contract_start_date||b.contract_end_date)));
    if(future.length)chosen=future[0];
  }
  if(!chosen&&rows.length){
    chosen=[...rows].sort((a,b)=>String(b.contract_end_date).localeCompare(String(a.contract_end_date)))[0];
  }

  const end=chosen?.contract_end_date||e.contract_end_date||null;
  const seq=chosen?.sequence_no||null;
  const days=daysUntil(end);
  return {end,seq,days,row:chosen};
}
function contractCountdownLabel(e){
  const info=currentContractInfo(e);
  if(info.days===null)return '계약일 없음';
  const prefix=info.seq?`${info.seq}차 계약`:'계약';
  if(info.days<0)return `${prefix} · ${Math.abs(info.days)}일 지남`;
  if(info.days===0)return `${prefix} · 오늘 만료`;
  return `${prefix} · ${info.days}일 남음`;
}


function addYearsSafe(date,years){
  const d=new Date(date.getFullYear()+years,date.getMonth(),date.getDate());
  if(d.getMonth()!==date.getMonth())return new Date(date.getFullYear()+years,date.getMonth()+1,0);
  return d;
}
const ANNUAL_LEAVE_MIN_WAGE={2023:9620,2024:9860,2025:10030,2026:10320};
function minWageForYear(year){return ANNUAL_LEAVE_MIN_WAGE[Number(year)]||null}

function contractRowsForLeave(e){
  const id=String(e?.id||'');
  if(currentEmployee&&String(currentEmployee.id||'')===id&&Array.isArray(contractHistory)&&contractHistory.length){
    return contractHistory.filter(r=>r?.contract_start_date).map(r=>({...r}));
  }
  return employeeContractRows(id).filter(r=>r?.contract_start_date).map(r=>({...r}));
}
function recontractStartForEmployee(e,asOf=today()){
  const hireKey=e?.hire_date||$('hireDate')?.value||'';
  if(!isoParts(hireKey))return null;
  const firstAnniversary=addYearsISO(hireKey,1);
  const asOfKey=localDateKey(asOf);
  const starts=contractRowsForLeave(e)
    .map(r=>r.contract_start_date)
    .filter(Boolean)
    .filter(s=>s>=firstAnniversary&&s<=asOfKey)
    .sort();
  if(!starts.length)return null;
  let start=starts.at(-1);
  // If a later renewal row has not been entered yet, keep the same renewal month/day cycle.
  while(addYearsISO(start,1)&&addYearsISO(start,1)<=asOfKey)start=addYearsISO(start,1);
  return start;
}
function previousRecontractStartForEmployee(e,currentStartKey){
  const hireKey=e?.hire_date||'';
  if(!isoParts(hireKey)||!isoParts(currentStartKey))return null;
  const firstAnniversary=addYearsISO(hireKey,1);
  const starts=contractRowsForLeave(e)
    .map(r=>r.contract_start_date)
    .filter(Boolean)
    .filter(s=>s>=firstAnniversary&&s<currentStartKey)
    .sort();
  if(starts.length)return starts.at(-1);
  const fallback=addYearsISO(currentStartKey,-1);
  return fallback&&fallback>=hireKey?fallback:hireKey;
}

function annualLeaveBaseForEmployee(e,asOf=today()){
  const hire=parseDate(e?.hire_date||$('hireDate')?.value);
  if(!hire)return {autoGranted:0,schedule:[],periodStart:null,periodEnd:null,nextSettlement:null,serviceYears:0,periodBasis:'입사일'};
  const hireKey=localDateKey(hire);
  const asOfKey=localDateKey(asOf);
  if(asOf<hire){
    const next=addYearsSafe(hire,1);
    return {autoGranted:0,schedule:[],periodStart:hireKey,periodEnd:localDateKey(new Date(next.getFullYear(),next.getMonth(),next.getDate()-1)),nextSettlement:localDateKey(next),serviceYears:0,periodBasis:'입사일'};
  }
  let years=asOf.getFullYear()-hire.getFullYear();
  let anniversary=addYearsSafe(hire,years);
  if(anniversary>asOf){years-=1;anniversary=addYearsSafe(hire,years)}
  years=Math.max(0,years);
  let schedule=[];
  let periodStart=hire;
  let nextSettlement=addYearsSafe(hire,1);
  let autoGranted=0;
  let periodBasis='입사일';
  if(years<1){
    for(let m=1;m<=11;m++){
      const accrualDate=addMonthsISO(hireKey,m);
      if(accrualDate&&accrualDate<=asOfKey){
        autoGranted+=1;
        schedule.push({date:accrualDate,year:Number(accrualDate.slice(0,4)),days:1});
      }
    }
    periodStart=hire;
    nextSettlement=addYearsSafe(hire,1);
  }else{
    autoGranted=Math.min(25,15+Math.floor((years-1)/2));
    const recontractKey=recontractStartForEmployee(e,asOf);
    if(recontractKey){
      periodStart=parseDate(recontractKey);
      nextSettlement=addYearsSafe(periodStart,1);
      periodBasis='재계약시작일';
    }else{
      periodStart=addYearsSafe(hire,years);
      nextSettlement=addYearsSafe(hire,years+1);
    }
    const accrualKey=localDateKey(periodStart);
    schedule.push({date:accrualKey,year:periodStart.getFullYear(),days:autoGranted});
  }
  const periodStartKey=localDateKey(periodStart);
  const periodEndDate=new Date(nextSettlement.getFullYear(),nextSettlement.getMonth(),nextSettlement.getDate()-1);
  return {autoGranted,schedule,periodStart:periodStartKey,periodEnd:localDateKey(periodEndDate),nextSettlement:localDateKey(nextSettlement),serviceYears:years,periodBasis};
}
function grantUnitsForAllowance(base,effectiveGranted,asOf=today()){
  const units=[];
  for(const b of base.schedule||[]){
    let left=Number(b.days||0);
    while(left>0){const part=Math.min(1,left);units.push({year:Number(b.year),days:part});left=Math.round((left-part)*100)/100}
  }
  let target=Math.max(0,Number(effectiveGranted||0));
  let total=units.reduce((s,u)=>s+u.days,0);
  while(total>target+0.0001&&units.length){
    const last=units[units.length-1];
    const remove=Math.min(last.days,total-target);
    last.days=Math.round((last.days-remove)*100)/100;
    total=Math.round((total-remove)*100)/100;
    if(last.days<=0.0001)units.pop();
  }
  const fallbackYear=base.schedule?.length?Number(base.schedule[base.schedule.length-1].year):asOf.getFullYear();
  while(total<target-0.0001){
    const add=Math.min(1,target-total);
    units.push({year:fallbackYear,days:Math.round(add*100)/100});
    total=Math.round((total+add)*100)/100;
  }
  return units;
}
function annualLeaveAllowance(base,granted,used,asOf=today(),extraUnits=[]){
  const units=[
    ...(extraUnits||[]).filter(u=>Number(u.days||0)>0).map(u=>({year:Number(u.year),days:Number(u.days)})),
    ...grantUnitsForAllowance(base,granted,asOf)
  ];
  let toUse=Math.max(0,Number(used||0));
  for(const u of units){
    if(toUse<=0)break;
    const usedHere=Math.min(u.days,toUse);
    u.days=Math.round((u.days-usedHere)*100)/100;
    toUse=Math.round((toUse-usedHere)*100)/100;
  }
  const breakdown={};
  const missing=new Set();
  let amount=0, payableDays=0;
  for(const u of units){
    if(u.days<=0)continue;
    payableDays+=u.days;
    const rate=minWageForYear(u.year);
    if(!rate){missing.add(u.year);continue}
    const value=u.days*8*rate;
    amount+=value;
    if(!breakdown[u.year])breakdown[u.year]={days:0,rate,amount:0};
    breakdown[u.year].days+=u.days;
    breakdown[u.year].amount+=value;
  }
  amount=Math.round(amount);
  payableDays=Math.round(payableDays*10)/10;
  return {amount,payableDays,breakdown,missingYears:[...missing].sort()};
}
function annualLeaveInfoForEmployee(e,asOf=today(),manualOverride=undefined,manualExtras=undefined){
  const base=annualLeaveBaseForEmployee(e,asOf);
  if(!base.periodStart){
    return {...base,granted:0,unused:0,carryover:0,extra:0,totalAvailable:0,used:0,remaining:0,allowance:annualLeaveAllowance(base,0,0,asOf)};
  }

  let granted=base.autoGranted;
  if(manualOverride!==undefined&&manualOverride!==null&&manualOverride!==''){
    const n=Number(manualOverride);if(Number.isFinite(n)&&n>=0)granted=n;
  }else if(e?.annual_leave_override_period_start===base.periodStart&&e?.annual_leave_granted_override!==null&&e?.annual_leave_granted_override!==undefined){
    const n=Number(e.annual_leave_granted_override);if(Number.isFinite(n)&&n>=0)granted=n;
  }

  const eligible=Number(base.serviceYears||0)>=1;
  let carryover=0;
  if(eligible){
    if(manualExtras&&manualExtras.carryover!==undefined){
      const c=Number(manualExtras.carryover);
      carryover=Number.isFinite(c)&&c>=0?c:0;
    }else{
      // 기존 버전에서 미사용/이월을 따로 입력했더라도 하나의 이월연차로 합산해 보존
      const legacyUnused=Number(e?.annual_leave_unused_days||0);
      const savedCarry=Number(e?.annual_leave_carryover_days||0);
      carryover=(Number.isFinite(legacyUnused)&&legacyUnused>0?legacyUnused:0)+(Number.isFinite(savedCarry)&&savedCarry>0?savedCarry:0);
    }
  }

  carryover=Math.round(carryover*10)/10;
  const unused=0;
  const extra=carryover;

  const employeeId=e?.id||$('empId')?.value||'';
  let used=0;
  if(employeeId){
    calendarEvents.forEach(ev=>{
      if(ev.event_type!=='연차')return;
      if(String(ev.employee_id||'')!==String(employeeId))return;
      if(!ev.start_date||ev.start_date<base.periodStart||ev.start_date>base.periodEnd)return;
      used+=Number(ev.leave_days||1)||0;
    });
  }

  used=Math.round(used*10)/10;
  granted=Math.round(Number(granted||0)*10)/10;
  const totalAvailable=Math.round((granted+extra)*10)/10;
  const remaining=Math.round((totalAvailable-used)*10)/10;

  // 미사용/이월 연차는 직전 정산기간 발생분으로 보고 최저시급 연도를 적용
  let extraYear=asOf.getFullYear();
  const prevStart=previousRecontractStartForEmployee(e,base.periodStart)||addYearsISO(base.periodStart,-1);
  if(prevStart&&isoParts(prevStart))extraYear=Number(prevStart.slice(0,4));
  const extraUnits=extra>0?[{year:extraYear,days:extra}]:[];
  const allowance=annualLeaveAllowance(base,granted,used,asOf,extraUnits);

  return {...base,granted,unused,carryover,extra,totalAvailable,used,remaining,allowance};
}
function annualLeaveInfoForPeriod(e,periodStartKey){
  if(!e?.hire_date||!periodStartKey)return null;
  const hire=parseDate(e.hire_date), periodStart=parseDate(periodStartKey);
  if(!hire||!periodStart)return null;
  const next=addYearsSafe(periodStart,1);
  const periodEnd=new Date(next.getFullYear(),next.getMonth(),next.getDate()-1);
  const periodEndKey=localDateKey(periodEnd);
  const years=Math.max(0,periodStart.getFullYear()-hire.getFullYear()-((periodStart.getMonth()<hire.getMonth()||(periodStart.getMonth()===hire.getMonth()&&periodStart.getDate()<hire.getDate()))?1:0));
  let granted=0;
  if(years<1){for(let m=1;m<=11;m++){const d=addMonthsISO(localDateKey(hire),m);if(d&&d<=periodEndKey)granted+=1}}
  else granted=Math.min(25,15+Math.floor((years-1)/2));
  let used=0;
  calendarEvents.forEach(ev=>{if(ev.event_type==='연차'&&String(ev.employee_id||'')===String(e.id||'')&&ev.start_date&&ev.start_date>=periodStartKey&&ev.start_date<=periodEndKey)used+=Number(ev.leave_days||1)||0});
  used=Math.round(used*10)/10; granted=Math.round(granted*10)/10;
  return {periodStart:periodStartKey,periodEnd:periodEndKey,granted,used,remaining:Math.round((granted-used)*10)/10};
}
function previousAnnualLeavePeriodInfo(e,current){
  if(!e?.hire_date||!current?.periodStart)return null;
  const cs=parseDate(current.periodStart), hire=parseDate(e.hire_date);
  if(!cs||!hire||cs<=hire)return null;
  const prevKey=previousRecontractStartForEmployee(e,current.periodStart);
  if(!prevKey)return null;
  return annualLeaveInfoForPeriod(e,prevKey);
}
function formatLeaveDays(v){
  const n=Number(v||0);
  return Number.isInteger(n)?`${n}일`:`${n.toFixed(1)}일`;
}
function formatWon(v){return `${Math.round(Number(v||0)).toLocaleString()}원`}
function allowanceBreakdownText(info){
  if(info.allowance.missingYears.length)return `최저시급 미등록 연도: ${info.allowance.missingYears.join(', ')}년`;
  const parts=Object.entries(info.allowance.breakdown).map(([year,b])=>`${year}년 ${formatLeaveDays(b.days)} × 8시간 × ${Number(b.rate).toLocaleString()}원`);
  return parts.length?parts.join(' + '):'잔여 연차가 없어 연차수당 0원';
}
function refreshAnnualLeaveSummary({autoSetSettlement=false,preserveGrantedInput=false,preserveExtraInput=false}={}){
  const e=currentEmployee
    ?{...currentEmployee,hire_date:$('hireDate').value||currentEmployee.hire_date,id:$('empId').value||currentEmployee.id}
    :{id:$('empId').value||'',hire_date:$('hireDate').value||null};

  const base=annualLeaveBaseForEmployee(e);
  const eligible=Number(base.serviceYears||0)>=1;
  show($('annualLeaveExtraFields'),eligible);

  if(!eligible){
    $('annualLeaveCarryoverInput').value='0';
  }else if(!preserveExtraInput){
    const legacyUnused=Number(e.annual_leave_unused_days||0);
    const savedCarry=Number(e.annual_leave_carryover_days||0);
    const combined=(Number.isFinite(legacyUnused)&&legacyUnused>0?legacyUnused:0)+(Number.isFinite(savedCarry)&&savedCarry>0?savedCarry:0);
    $('annualLeaveCarryoverInput').value=String(Math.round(combined*10)/10);
  }

  let override;
  if(preserveGrantedInput&&$('annualLeaveGrantedInput').value!=='')override=Number($('annualLeaveGrantedInput').value);

  const manualExtras={
    carryover:eligible?Number($('annualLeaveCarryoverInput').value||0):0
  };
  const info=annualLeaveInfoForEmployee(e,today(),override,manualExtras);

  if(!preserveGrantedInput)$('annualLeaveGrantedInput').value=String(info.granted);
  $('annualLeaveAutoValue').textContent=`자동 계산 ${formatLeaveDays(base.autoGranted)}`;
  $('annualLeaveGranted').textContent=formatLeaveDays(info.granted);
  $('annualLeaveExtraTotal').textContent=formatLeaveDays(info.extra);
  $('annualLeaveTotalAvailable').textContent=formatLeaveDays(info.totalAvailable);
  $('annualLeaveUsed').textContent=formatLeaveDays(info.used);
  $('annualLeaveRemaining').textContent=formatLeaveDays(info.remaining);
  $('annualLeaveRemaining').classList.toggle('negative',info.remaining<0);
  $('annualLeaveAllowance').textContent=info.allowance.missingYears.length?'계산불가':formatWon(info.allowance.amount);

  if(autoSetSettlement&&info.nextSettlement)$('annualLeaveSettlementDate').value=info.nextSettlement;

  if(!e.hire_date){
    $('annualLeaveNote').textContent='입사일을 입력하면 자동 계산됩니다.';
    $('annualLeaveAllowanceNote').textContent='1일 8시간 · 연차 발생연도 최저시급 기준';
    return;
  }

  const edited=Math.abs(Number(info.granted)-Number(base.autoGranted))>0.001?' · 발생일수 수동수정 적용':'';
  const extraNote=eligible?` · 이월 ${formatLeaveDays(info.carryover)}`:'';
  $('annualLeaveNote').textContent=`현재 연차기간 ${info.periodStart||'-'} ~ ${info.periodEnd||'-'} · ${info.periodBasis==='재계약시작일'?'재계약시작일 기준':'입사일 기준'} · 다음 정산 ${info.nextSettlement||'-'}${edited}${extraNote}`;
  $('annualLeaveAllowanceNote').textContent=`${allowanceBreakdownText(info)} = ${info.allowance.missingYears.length?'계산불가':formatWon(info.allowance.amount)} · 이월 연차는 직전 정산기간 발생분 기준`;
}
function autoGenerateAnnualLeave(){
  if(!$('hireDate').value){alert('입사일을 먼저 입력해주세요.');$('hireDate').focus();return}
  const e=currentEmployee?{...currentEmployee,hire_date:$('hireDate').value}:{hire_date:$('hireDate').value};
  const base=annualLeaveBaseForEmployee(e);
  $('annualLeaveGrantedInput').value=String(base.autoGranted);
  refreshAnnualLeaveSummary({autoSetSettlement:true,preserveGrantedInput:true});
}
function populateLeaveEmployeeSelect(selectedId=''){
  const select=$('calendarLeaveEmployee');
  const active=employees.filter(e=>!isTerminated(e)).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ko'));
  select.innerHTML='<option value="">직원 선택</option>'+active.map(e=>`<option value="${esc(e.id)}">${esc(e.name)}${e.department?` · ${esc(e.department)}`:''}</option>`).join('');
  if(selectedId)select.value=String(selectedId);
}
function updateCalendarLeaveFields(){
  const annual=$('calendarEventType').value==='연차';
  show($('calendarLeaveEmployeeField'),annual);
  show($('calendarLeaveDaysField'),annual);
  $('calendarLeaveEmployee').required=annual;
  $('calendarLeaveDays').required=annual;
  if(annual){
    if(!$('calendarLeaveDays').value)$('calendarLeaveDays').value='1';
  }else{
    $('calendarLeaveEmployee').required=false;
    $('calendarLeaveDays').required=false;
  }
}
function syncAnnualLeaveTitle(){
  if($('calendarEventType').value!=='연차')return;
  const id=$('calendarLeaveEmployee').value;
  const e=employees.find(x=>String(x.id)===String(id));
  if(!e)return;
  const title=$('calendarEventTitle').value.trim();
  if(!title||/\s연차$/.test(title))$('calendarEventTitle').value=`${e.name} 연차`;
}

function show(el,on=true){el.classList.toggle('hidden',!on)}
function autoGrow(el){if(!el)return;el.style.height='42px';el.style.height=Math.max(42,el.scrollHeight)+'px'}
function resizeMemoFields(){autoGrow($('notes'));autoGrow($('workHistory'))}

function setNationality(type,{clearVisa=false}={}){
  const foreign=type==='foreign';
  $('nationalityLocal').checked=!foreign;
  $('nationalityForeign').checked=foreign;
  show($('visaField'),foreign);
  $('visa').required=foreign;
  if(!foreign&&clearVisa)$('visa').value='';
}

function updateHandoverVisibility(){
  const hire=$('hireDate')?.value||'';
  const hide=!!hire && hire>='2025-08-01';
  show($('handoverDateField'),!hide);
  if(hide)$('handoverDate').value='';
}

function nationalityLabel(e){return String(e?.visa||'').trim()?'외국인':'내국인'}


function localDateKey(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function monthBounds(d){
  const start=new Date(d.getFullYear(),d.getMonth(),1);
  const end=new Date(d.getFullYear(),d.getMonth()+1,0);
  return {start:localDateKey(start),end:localDateKey(end)};
}
function formatMonthTitle(d){return `${d.getFullYear()}년 ${d.getMonth()+1}월`}

const koreanHolidayCache=new Map();
function cloneDate(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate())}
function addDays(d,n){const x=cloneDate(d);x.setDate(x.getDate()+n);return x}
function lunarMonthDay(d){
  try{
    const parts=new Intl.DateTimeFormat('en-u-ca-chinese',{month:'numeric',day:'numeric'}).formatToParts(d);
    const monthRaw=parts.find(p=>p.type==='month')?.value||'';
    const dayRaw=parts.find(p=>p.type==='day')?.value||'';
    return {month:parseInt(monthRaw,10),day:parseInt(dayRaw,10),leap:/bis/i.test(monthRaw)};
  }catch(e){return null}
}
function findLunarDate(year,month,day){
  const start=new Date(year,0,1),end=new Date(year,11,31);
  for(let d=cloneDate(start);d<=end;d=addDays(d,1)){
    const p=lunarMonthDay(d);
    if(p&&!p.leap&&p.month===month&&p.day===day)return cloneDate(d);
  }
  return null;
}
function koreanHolidaysForYear(year){
  if(koreanHolidayCache.has(year))return koreanHolidayCache.get(year);
  const map=new Map();
  const namedDates=new Map();
  const add=(d,name)=>{
    if(!d||d.getFullYear()!==year)return;
    const key=localDateKey(d);
    if(!map.has(key))map.set(key,[]);
    if(!map.get(key).includes(name))map.get(key).push(name);
    if(!namedDates.has(name))namedDates.set(name,[]);
    if(!namedDates.get(name).includes(key))namedDates.get(name).push(key);
  };
  const fixed=(m,d,name)=>add(new Date(year,m-1,d),name);
  fixed(1,1,'신정');
  fixed(3,1,'삼일절');
  fixed(5,5,'어린이날');
  fixed(6,6,'현충일');
  fixed(8,15,'광복절');
  fixed(10,3,'개천절');
  fixed(10,9,'한글날');
  fixed(12,25,'성탄절');

  const seollal=findLunarDate(year,1,1);
  const seolDates=seollal?[addDays(seollal,-1),seollal,addDays(seollal,1)]:[];
  if(seolDates.length){add(seolDates[0],'설날 연휴');add(seolDates[1],'설날');add(seolDates[2],'설날 연휴')}
  const buddha=findLunarDate(year,4,8);if(buddha)add(buddha,'부처님오신날');
  const chuseok=findLunarDate(year,8,15);
  const chuDates=chuseok?[addDays(chuseok,-1),chuseok,addDays(chuseok,1)]:[];
  if(chuDates.length){add(chuDates[0],'추석 연휴');add(chuDates[1],'추석');add(chuDates[2],'추석 연휴')}

  // 전국 단위 선거일 중 법정 공휴일로 확정된 주요 일정
  if(year===2025)add(new Date(2025,5,3),'대통령선거');
  if(year===2026)add(new Date(2026,5,3),'지방선거');
  if(year===2028)add(new Date(2028,3,12),'국회의원선거');

  // 대체공휴일
  const original=new Map([...map].map(([k,v])=>[k,[...v]]));
  const isWeekend=key=>{const d=parseDate(key);return d&&(d.getDay()===0||d.getDay()===6)};
  const isSunday=key=>{const d=parseDate(key);return d&&d.getDay()===0};
  const nextWorkdayAfter=(date)=>{
    let d=addDays(date,1);
    for(let guard=0;guard<14;guard++,d=addDays(d,1)){
      const key=localDateKey(d);
      if(d.getDay()!==0&&d.getDay()!==6&&!map.has(key))return d;
    }
    return d;
  };
  const processed=new Set();
  const substituteSingles=['삼일절','어린이날','부처님오신날','광복절','개천절','한글날','성탄절'];
  substituteSingles.forEach(name=>{
    (namedDates.get(name)||[]).forEach(key=>{
      if(processed.has(key))return;
      const collision=(original.get(key)||[]).length>1;
      if(isWeekend(key)||collision){
        processed.add(key);
        add(nextWorkdayAfter(parseDate(key)),'대체공휴일');
      }
    });
  });
  const groupSubstitute=(dates)=>{
    if(!dates.length)return;
    const keys=dates.filter(d=>d&&d.getFullYear()===year).map(localDateKey);
    const trigger=keys.some(key=>isSunday(key)||(original.get(key)||[]).length>1);
    if(trigger){
      const last=dates[dates.length-1];
      add(nextWorkdayAfter(last),'대체공휴일');
    }
  };
  groupSubstitute(seolDates);
  groupSubstitute(chuDates);

  koreanHolidayCache.set(year,map);
  return map;
}
function koreanHolidayNames(dateKey){
  const year=Number(String(dateKey).slice(0,4));
  return koreanHolidaysForYear(year).get(dateKey)||[];
}

function eventTypeClass(type){
  return ({'연차':'annual','휴가':'vacation','결근':'absence','지각/조퇴':'earlyleave','퇴사':'exit','면접':'interview','입사':'hire','생일':'birthday','계약만료':'contract','기타':'other'})[type]||'other'
}
function birthdayDisplayName(event){
  const title=String(event?.title||'').trim();
  return title.replace(/\s*생일\s*$/,'').trim()||title;
}
function autoTerminationEvents(){
  return employees.filter(e=>!!e.termination_date).map(e=>({
    id:`employee-exit-${e.id}-${e.termination_date}`,
    site:siteOf(e),
    event_type:'퇴사',
    title:`${e.name} 퇴사`,
    start_date:e.termination_date,
    end_date:e.termination_date,
    memo:e.department?`${e.department}`:'',
    source:'employee',
    employee_id:e.id,
    readonly:true
  }));
}
function autoHireEvents(){
  return employees.filter(e=>!!e.hire_date).map(e=>({
    id:`employee-hire-${e.id}-${e.hire_date}`,
    site:siteOf(e),
    event_type:'입사',
    title:`${e.name} 입사`,
    start_date:e.hire_date,
    end_date:e.hire_date,
    memo:e.department?`${e.department}`:'',
    source:'employee',
    employee_id:e.id,
    readonly:true
  }));
}
function residentBirthdayMMDD(value){
  const digits=String(value||'').replace(/\D/g,'');
  if(digits.length<6)return null;
  const mm=Number(digits.slice(2,4));
  const dd=Number(digits.slice(4,6));
  const probe=new Date(2000,mm-1,dd);
  if(!mm||!dd||probe.getMonth()!==mm-1||probe.getDate()!==dd)return null;
  return `${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}
function birthdayDateForYear(mmdd,year){
  if(!mmdd)return null;
  const [m,d]=mmdd.split('-').map(Number);
  const probe=new Date(year,m-1,d);
  if(probe.getFullYear()!==year||probe.getMonth()!==m-1||probe.getDate()!==d)return null;
  return localDateKey(probe);
}
function autoBirthdayEvents(){
  const year=calendarMonth.getFullYear();
  return employees.filter(e=>!isTerminated(e)).map(e=>{
    const mmdd=residentBirthdayMMDD(e.resident_no);
    const date=birthdayDateForYear(mmdd,year);
    if(!date)return null;
    return {
      id:`employee-birthday-${e.id}-${year}`,
      site:siteOf(e),
      event_type:'생일',
      title:`${e.name} 생일`,
      start_date:date,
      end_date:date,
      memo:e.department?`${e.department}`:'',
      source:'employee',
      employee_id:e.id,
      readonly:true
    };
  }).filter(Boolean);
}
function autoEmployeeCalendarEvents(){
  return [...autoTerminationEvents(),...autoHireEvents(),...autoBirthdayEvents()];
}
function allCalendarEvents(){
  return [...calendarEvents.map(e=>({...e,source:'calendar'})),...autoEmployeeCalendarEvents()];
}
function eventMatchesType(e){
  return calendarTypeFilter==='전체'||e.event_type===calendarTypeFilter;
}
function eventOccursOn(e,date){
  const end=e.end_date||e.start_date;
  if(end===e.start_date)return date===e.start_date;
  return date===e.start_date||date===end;
}
function monthCalendarEvents(){
  const b=monthBounds(calendarMonth);
  return allCalendarEvents().filter(e=>eventMatchesType(e)&&eventInCompany(e)&&e.start_date<=b.end&&(e.end_date||e.start_date)>=b.start)
    .sort((a,b)=>a.start_date.localeCompare(b.start_date)||(a.title||'').localeCompare(b.title||'','ko'));
}
async function loadCalendarEvents(silent=false){
  if(!sb)return;
  const {data,error}=await sb.from(CAL_TABLE).select('*').order('start_date',{ascending:true}).order('created_at',{ascending:true});
  if(error){
    calendarLoadError=error.message||'공유달력 데이터를 불러오지 못했습니다.';
    calendarEvents=[];
    if(!silent&&currentTab==='달력')renderCalendar();
    if(!silent&&currentTab==='연차현황')renderAnnualLeaveHistory();
    return;
  }
  calendarLoadError='';
  calendarEvents=data||[];
  if(currentTab==='대시보드')renderDashboard();
  if(currentTab==='달력')renderCalendar();
  if(currentTab==='연차현황')renderAnnualLeaveHistory();
}
function birthdayCheckKey(employeeId,year){return `${employeeId}:${year}`}
function birthdayIsChecked(employeeId,year){
  const key=birthdayCheckKey(employeeId,year);
  return birthdayChecks.some(x=>birthdayCheckKey(x.employee_id,Number(x.birthday_year))===key);
}
async function loadBirthdayChecks(silent=false){
  if(!sb)return;
  const {data,error}=await sb.from(BIRTHDAY_TABLE).select('*');
  if(error){
    birthdayCheckError=error.message||'생일 챙김 데이터를 불러오지 못했습니다.';
    birthdayChecks=[];
    if(!silent&&currentTab==='달력')renderCalendar();
    return;
  }
  birthdayCheckError='';
  birthdayChecks=data||[];
  if(currentTab==='달력')renderCalendar();
}
async function toggleBirthdayCheck(employeeId,year){
  if(!employeeId||!year)return;
  if(birthdayCheckError){
    alert('생일 챙김 기능용 Supabase SQL을 먼저 실행해주세요.');
    return;
  }
  const checked=birthdayIsChecked(employeeId,year);
  try{
    if(checked){
      const {error}=await sb.from(BIRTHDAY_TABLE).delete().eq('employee_id',employeeId).eq('birthday_year',year);
      if(error)throw error;
    }else{
      const {data:{user}}=await sb.auth.getUser();
      const payload={employee_id:employeeId,birthday_year:year,checked_at:new Date().toISOString(),checked_by:user?.id||null};
      const {error}=await sb.from(BIRTHDAY_TABLE).upsert(payload,{onConflict:'employee_id,birthday_year'});
      if(error)throw error;
    }
    await loadBirthdayChecks(true);
    renderCalendar();
  }catch(e){alert('생일 챙김 상태 저장 실패: '+e.message)}
}
function subscribeCalendar(){
  if(!sb||calendarRealtime)return;
  try{
    calendarRealtime=sb.channel('sewon-shared-calendar-events')
      .on('postgres_changes',{event:'*',schema:'public',table:CAL_TABLE},()=>loadCalendarEvents(true))
      .on('postgres_changes',{event:'*',schema:'public',table:BIRTHDAY_TABLE},()=>loadBirthdayChecks(true))
      .subscribe();
  }catch(e){console.warn('공유달력 실시간 연결 실패',e)}
}
function setCalendarMode(on){
  hideErpViews();
  show($('toolbarSection'),!on);
  show($('statsSection'),!on);
  show($('searchRow'),!on);
  show($('employeeSection'),!on);
  show($('calendarView'),on);
  show($('annualLeaveHistoryView'),false);
  show($('addBtn'),!on);
}
function setAnnualLeaveHistoryMode(on){
  hideErpViews();
  show($('toolbarSection'),!on);
  show($('statsSection'),!on);
  show($('searchRow'),!on);
  show($('employeeSection'),!on);
  show($('calendarView'),false);
  show($('annualLeaveHistoryView'),on);
  show($('addBtn'),!on);
}
function renderCalendar(){
  if(currentTab!=='달력')return;
  setCalendarMode(true);
  $('calendarTypeFilter').value=calendarTypeFilter;
  $('calendarMonthTitle').textContent=formatMonthTitle(calendarMonth);

  const setupMessages=[];
  if(calendarLoadError)setupMessages.push('공유달력 DB 설정이 필요합니다.');
  if(birthdayCheckError)setupMessages.push('생일 챙김 기능용 Supabase SQL 설정이 필요합니다.');
  if(setupMessages.length){
    $('calendarSetupNotice').textContent=setupMessages.join(' ');
    show($('calendarSetupNotice'));
  }else show($('calendarSetupNotice'),false);

  const events=monthCalendarEvents();
  const listEvents=events.filter(e=>e.event_type!=='생일');
  $('calendarCount').textContent=`${listEvents.length}건`;
  const first=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth(),1);
  const days=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,0).getDate();
  const cells=[];
  for(let i=0;i<first.getDay();i++)cells.push('<div class="calendar-day outside"></div>');
  const todayKey=localDateKey(new Date());
  for(let day=1;day<=days;day++){
    const dayDate=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth(),day);
    const date=localDateKey(dayDate);
    const holidayNames=koreanHolidayNames(date);
    const isSunday=dayDate.getDay()===0;
    const isSaturday=dayDate.getDay()===6;
    const dayEvents=events.filter(e=>eventOccursOn(e,date));
    const birthdayEvents=dayEvents.filter(e=>e.event_type==='생일');
    const normalEvents=dayEvents.filter(e=>e.event_type!=='생일');
    const birthdayInline=birthdayEvents.map(e=>{
      const name=birthdayDisplayName(e);
      const year=calendarMonth.getFullYear();
      const checked=birthdayIsChecked(e.employee_id,year);
      return `<div class="calendar-birthday-card${checked?' checked':''}">
        <button type="button" class="calendar-birthday-inline" data-calendar-source="${e.source}" data-calendar-id="${esc(e.id)}" title="${esc(e.title)}"><span class="birthday-cake">🎂</span><span class="birthday-name">${esc(name)}</span></button>
        <button type="button" class="birthday-check-toggle ${checked?'done':'pending'}" data-birthday-check="${esc(e.employee_id)}" data-birthday-year="${year}" aria-pressed="${checked?'true':'false'}">${checked?'✓ 챙김':'미챙김'}</button>
      </div>`;
    }).join('');
    const visible=normalEvents.map(e=>{
      const isRange=e.end_date&&e.end_date!==e.start_date;
      const isEnd=isRange&&date===e.end_date;
      const label=isEnd?`${e.title} 종료`:e.title;
      const tooltip=isRange?`${e.title} ${e.start_date} ~ ${e.end_date}`:e.title;
      const singleLine=true;
      const labelHtml=`<span class="calendar-singleline-text">${esc(label)}</span>`;
      return `<button type="button" class="calendar-chip ${eventTypeClass(e.event_type)} single-line" data-calendar-source="${e.source}" data-calendar-id="${esc(e.id)}" title="${esc(tooltip)}">${labelHtml}</button>`;
    }).join('');
    const holidayHtml=holidayNames.length?`<div class="calendar-holiday-name" title="${esc(holidayNames.join(' · '))}">${esc(holidayNames.join(' · '))}</div>`:'';
    const dayClasses=[date===todayKey?'today':'',isSunday?'sunday':'',isSaturday?'saturday':'',holidayNames.length?'public-holiday':''].filter(Boolean).join(' ');
    cells.push(`<div class="calendar-day${dayClasses?' '+dayClasses:''}" data-calendar-date="${date}"><div class="calendar-day-top"><div class="calendar-day-number">${day}</div></div>${holidayHtml}<div class="calendar-day-events">${birthdayInline}${visible}</div></div>`);
  }
  $('calendarGrid').innerHTML=cells.join('');

  if(!listEvents.length){
    $('calendarList').innerHTML='<div class="empty">이 달에 등록된 일정이 없습니다.</div>';
  }else{
    $('calendarList').innerHTML=listEvents.map(e=>{
      const range=e.end_date&&e.end_date!==e.start_date?`${e.start_date} ~ ${e.end_date}`:e.start_date;
      const memo=e.memo?`<p>${esc(e.memo)}</p>`:'';
      const auto=e.source==='employee'?'<span class="calendar-auto-badge">자동</span>':'';
      return `<button type="button" class="calendar-list-item" data-calendar-source="${e.source}" data-calendar-id="${esc(e.id)}">
        <div class="calendar-list-date">${esc(range)}</div>
        <div class="calendar-list-main">
          <div><span class="calendar-type ${eventTypeClass(e.event_type)}">${esc(e.event_type)}</span><span class="calendar-site">${esc(e.site||'전체')}</span>${auto}</div>
          <strong>${esc(e.title)}</strong>${memo}
        </div>
      </button>`;
    }).join('');
  }

  document.querySelectorAll('[data-calendar-date]').forEach(cell=>cell.addEventListener('click',e=>{
    if(e.target.closest('[data-calendar-id],[data-birthday-check]'))return;
    openCalendarEventModal(null,cell.dataset.calendarDate);
  }));
  document.querySelectorAll('[data-birthday-check]').forEach(el=>el.addEventListener('click',async e=>{
    e.stopPropagation();
    await toggleBirthdayCheck(el.dataset.birthdayCheck,Number(el.dataset.birthdayYear));
  }));
  document.querySelectorAll('[data-calendar-id]').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    openCalendarEntry(el.dataset.calendarSource,el.dataset.calendarId);
  }));
}
function openCalendarEntry(source,id){
  if(source==='employee'){
    const auto=autoEmployeeCalendarEvents().find(e=>e.id===id);
    if(auto?.employee_id)openEdit(auto.employee_id);
    return;
  }
  openCalendarEventModal(id);
}
function openCalendarEventModal(id=null,date=null){
  currentCalendarEvent=id?calendarEvents.find(e=>String(e.id)===String(id)):null;
  $('calendarEventForm').reset();
  $('calendarEventId').value=currentCalendarEvent?.id||'';
  $('calendarEventModalTitle').textContent=currentCalendarEvent?'일정 수정':'일정 등록';
  $('calendarEventSite').value=currentCalendarEvent?.site||'세원';
  $('calendarEventType').value=currentCalendarEvent?.event_type||((calendarTypeFilter!=='전체'&&calendarTypeFilter!=='생일')?calendarTypeFilter:'연차');
  $('calendarEventTitle').value=currentCalendarEvent?.title||'';
  $('calendarEventStart').value=currentCalendarEvent?.start_date||date||localDateKey(new Date());
  $('calendarEventEnd').value=currentCalendarEvent?.end_date||'';
  $('calendarEventMemo').value=currentCalendarEvent?.memo||'';
  populateLeaveEmployeeSelect(currentCalendarEvent?.employee_id||'');
  $('calendarLeaveDays').value=String(currentCalendarEvent?.leave_days||1);
  updateCalendarLeaveFields();
  show($('calendarEventDelete'),!!currentCalendarEvent);
  show($('calendarEventModal'));
  const card=$('calendarEventModal').querySelector('.modal-card');
  if(card)card.scrollTop=0;
}
function closeCalendarEventModal(){
  show($('calendarEventModal'),false);
  currentCalendarEvent=null;
}
async function saveCalendarEvent(ev){
  ev.preventDefault();
  const start=$('calendarEventStart').value;
  const end=$('calendarEventEnd').value||null;
  if(end&&end<start){alert('종료일은 시작일보다 빠를 수 없습니다.');return}
  const obj={
    site:$('calendarEventSite').value,
    event_type:$('calendarEventType').value,
    title:$('calendarEventTitle').value.trim(),
    start_date:start,
    end_date:end,
    memo:$('calendarEventMemo').value.trim()||null,
    updated_at:new Date().toISOString()
  };
  if(obj.event_type==='연차'){
    const employeeId=$('calendarLeaveEmployee').value;
    const leaveDays=Number($('calendarLeaveDays').value||1);
    if(!employeeId){alert('연차 대상 직원을 선택해주세요.');return}
    if(!leaveDays||leaveDays<=0){alert('연차 사용일수를 확인해주세요.');return}
    obj.employee_id=employeeId;
    obj.leave_days=leaveDays;
    const selectedEmployee=employees.find(e=>String(e.id)===String(employeeId));
    if(selectedEmployee&&!obj.title)obj.title=`${selectedEmployee.name} 연차`;
  }else{
    obj.employee_id=null;
    obj.leave_days=null;
  }
  if(!obj.title){alert('일정명을 입력해주세요.');return}
  try{
    if(currentCalendarEvent){
      const {error}=await sb.from(CAL_TABLE).update(obj).eq('id',currentCalendarEvent.id);
      if(error)throw error;
    }else{
      const {data:{user}}=await sb.auth.getUser();
      obj.created_by=user?.id||null;
      const {error}=await sb.from(CAL_TABLE).insert(obj);
      if(error)throw error;
    }
    closeCalendarEventModal();
    await loadCalendarEvents(true);
    if(currentEmployee)refreshAnnualLeaveSummary();
    renderCalendar();
  }catch(e){alert('일정 저장 실패: '+e.message)}
}
async function deleteCalendarEvent(){
  if(!currentCalendarEvent)return;
  if(!confirm(`"${currentCalendarEvent.title}" 일정을 삭제할까요?`))return;
  try{
    const {error}=await sb.from(CAL_TABLE).delete().eq('id',currentCalendarEvent.id);
    if(error)throw error;
    closeCalendarEventModal();
    await loadCalendarEvents(true);
    if(currentEmployee)refreshAnnualLeaveSummary();
    renderCalendar();
  }catch(e){alert('일정 삭제 실패: '+e.message)}
}

async function loadEmployees(){
  const {data,error}=await sb.from(EMP_TABLE).select('*').order('hire_date',{ascending:true,nullsFirst:false}).order('name',{ascending:true});
  if(error)throw error;
  employees=data||[];
  docColumnsReady=!employees.length||Object.prototype.hasOwnProperty.call(employees[0],'doc_pledge_submitted');
  contractRowsByEmployee=new Map();
  try{
    const {data:hist,error:histError}=await sb.from(CONTRACT_TABLE)
      .select('employee_id,sequence_no,contract_start_date,contract_end_date,actual_write_date,status')
      .order('sequence_no',{ascending:true});
    if(histError)throw histError;
    (hist||[]).forEach(r=>{
      const key=String(r.employee_id||'');
      if(!contractRowsByEmployee.has(key))contractRowsByEmployee.set(key,[]);
      contractRowsByEmployee.get(key).push(r);
    });
  }catch(e){
    console.warn('카드용 근로계약 이력 불러오기 실패',e);
  }
  uniReady=null;await loadDepartments();
  render();
}
function filteredBase(){let a=[...employees]; const q=$('searchInput').value.trim().toLowerCase(); if(currentTab==='퇴사자'){a=a.filter(isTerminated);const mm=$('exitMonth')?.value||'';if(mm)a=a.filter(e=>String(e.termination_date||'').slice(0,7)===mm);a.sort((x,y)=>String(y.termination_date||'').localeCompare(String(x.termination_date||''))||x.name.localeCompare(y.name,'ko'))} else if(currentTab==='퇴사예정')a=a.filter(isExitScheduled).sort((x,y)=>daysUntil(x.termination_date)-daysUntil(y.termination_date)); else if(currentTab==='만료예정')a=a.filter(isExpiring).sort((x,y)=>String(currentContractInfo(x).end||'').localeCompare(String(currentContractInfo(y).end||''))); else {a=a.filter(e=>!isTerminated(e))} a=a.filter(inCompany); if(q)a=a.filter(e=>[e.name,e.phone,e.department,e.visa,e.address,e.interview_route,e.locker_room,e.tax_type,nationalityLabel(e)].some(v=>String(v||'').toLowerCase().includes(q))); return a}
// v004: 대시보드 카드에서 온 '이번 달' 조건
let listFilter='';
const LIST_FILTER_LABEL={hireMonth:'이번 달 입사',exitMonth:'이번 달 퇴사'};
function filtered(){
  if(!listFilter)return filteredBase();
  const m=localDateKey(today()).slice(0,7);
  const q=$('searchInput').value.trim().toLowerCase();
  let a=employees.filter(inCompany).filter(e=>String(listFilter==='hireMonth'?e.hire_date:e.termination_date||'').slice(0,7)===m);
  if(q)a=a.filter(e=>[e.name,e.phone,e.department].some(v=>String(v||'').toLowerCase().includes(q)));
  return a.sort((x,y)=>String(listFilter==='hireMonth'?x.hire_date:x.termination_date).localeCompare(String(listFilter==='hireMonth'?y.hire_date:y.termination_date)));
}
function annualLeaveUsageEvents(employeeId){
  return calendarEvents
    .filter(ev=>ev.event_type==='연차'&&String(ev.employee_id||'')===String(employeeId||''))
    .sort((a,b)=>String(b.start_date||'').localeCompare(String(a.start_date||''))||String(b.created_at||'').localeCompare(String(a.created_at||'')));
}
function leaveUsageDateLabel(ev){
  if(!ev?.start_date)return '-';
  const memo=String(ev.memo||'');
  const monthly=memo.match(/^\[기존 연차대장 월합계\]\s*(\d{4})-(\d{2})/)
    || memo.match(/^\[기존 연차대장\]\s*(\d{4})-(\d{2})/);
  if(monthly)return `${monthly[1]}년 ${Number(monthly[2])}월`;
  if(ev.end_date&&ev.end_date!==ev.start_date)return `${ev.start_date} ~ ${ev.end_date}`;
  return ev.start_date;
}
function ensureLeaveHistoryYears(){
  const select=$('leaveHistoryYear');
  if(!select)return;
  const current=select.value||'전체';
  const years=[...new Set(calendarEvents.filter(e=>e.event_type==='연차'&&e.start_date).map(e=>String(e.start_date).slice(0,4)).filter(Boolean))]
    .sort((a,b)=>Number(b)-Number(a));
  select.innerHTML='<option value="전체">전체기간</option>'+years.map(y=>`<option value="${esc(y)}">${esc(y)}년</option>`).join('');
  select.value=years.includes(current)?current:'전체';
}
function renderAnnualLeaveHistory(){
  if(currentTab!=='연차현황')return;
  setAnnualLeaveHistoryMode(true); ensureLeaveHistoryYears();
  const q=($('leaveHistorySearch')?.value||'').trim().toLowerCase();
  const year=$('leaveHistoryYear')?.value||'전체';
  const rows=employees.filter(e=>!isTerminated(e)).filter(inCompany).filter(e=>!q||[e.name,e.department,e.phone,e.visa].some(v=>String(v||'').toLowerCase().includes(q)));
  let visibleEventCount=0,visibleUsedDays=0,usedEmployeeCount=0;
  const html=rows.map(e=>{
    const current=annualLeaveInfoForEmployee(e), previous=previousAnnualLeavePeriodInfo(e,current);
    const usage=annualLeaveUsageEvents(e.id).filter(ev=>year==='전체'||String(ev.start_date||'').slice(0,4)===year);
    const cur=usage.filter(ev=>ev.start_date>=current.periodStart&&ev.start_date<=current.periodEnd);
    const old=usage.filter(ev=>!(ev.start_date>=current.periodStart&&ev.start_date<=current.periodEnd));
    if(usage.length)usedEmployeeCount++; visibleEventCount+=usage.length; visibleUsedDays+=usage.reduce((s,ev)=>s+(Number(ev.leave_days||1)||0),0);
    const rowsHtml=items=>items.map(ev=>`<button type="button" class="leave-use-row" data-leave-event-id="${esc(ev.id)}"><span class="leave-use-date">${esc(leaveUsageDateLabel(ev))}</span><strong>${esc(formatLeaveDays(Number(ev.leave_days||1)||0))}</strong></button>`).join('');
    const curHtml=`<div class="leave-period-section current"><div class="leave-period-title"><strong>현재 연차기간 사용</strong><span>${formatLeaveDays(current.used)} 차감</span></div>${cur.length?rowsHtml(cur):'<div class="leave-history-empty">현재 기간 사용 이력 없음</div>'}</div>`;
    const prevSummary=previous?`<div class="leave-prev-summary"><span>직전 정산기간 ${esc(previous.periodStart)} ~ ${esc(previous.periodEnd)}</span><b>발생 ${formatLeaveDays(previous.granted)} · 사용 ${formatLeaveDays(previous.used)} · 잔여 ${formatLeaveDays(previous.remaining)}</b></div>`:'';
    const oldHtml=old.length?`<details class="leave-old-details"><summary>이전 연차기간 사용이력 ${old.length}건 보기</summary>${prevSummary}${rowsHtml(old)}</details>`:prevSummary;
    return `<article class="leave-history-card"><div class="leave-history-person"><div class="leave-history-name"><button type="button" class="leave-name-button" data-leave-employee-id="${esc(e.id)}">${esc(e.name)}</button><span>${esc(e.department||'')} · 입사 ${esc(fmtDate(e.hire_date))}</span></div><div class="leave-history-balance"><span>발생 <b>${esc(formatLeaveDays(current.granted))}</b></span>${current.carryover>0?`<span>이월 <b>${esc(formatLeaveDays(current.carryover))}</b></span>`:''}<span>총보유 <b>${esc(formatLeaveDays(current.totalAvailable))}</b></span><span>현재사용 <b>${esc(formatLeaveDays(current.used))}</b></span><span class="remaining${current.remaining<0?' negative':''}">잔여 <b>${esc(formatLeaveDays(current.remaining))}</b></span></div></div><div class="leave-history-period">현재 연차기간 ${esc(current.periodStart||'-')} ~ ${esc(current.periodEnd||'-')} · ${current.periodBasis==='재계약시작일'?'재계약시작일 기준':'입사일 기준'}</div><div class="leave-use-list">${curHtml}${oldHtml}</div></article>`;
  }).join('');
  $('leaveHistoryEmployeeCount').textContent=`${usedEmployeeCount}명`; $('leaveHistoryEventCount').textContent=`${visibleEventCount}건`; $('leaveHistoryUsedDays').textContent=formatLeaveDays(Math.round(visibleUsedDays*10)/10); $('leaveHistoryList').innerHTML=html||'<div class="empty">표시할 직원이 없습니다.</div>';
  renderLeaveTable(rows);document.querySelectorAll('[data-leave-event-id]').forEach(el=>el.addEventListener('click',()=>openCalendarEventModal(el.dataset.leaveEventId))); document.querySelectorAll('[data-leave-employee-id]').forEach(el=>el.addEventListener('click',()=>openEdit(el.dataset.leaveEmployeeId)));
}

// ===== 가나안ERP (v001): 회사 구분 · 대시보드 · 서류 체크 · 부서 관리 · 엑셀 가져오기 =====
const COMPANIES=['세원','대한전선'];
const TAB_LABELS={'대시보드':'대시보드','직원':'직원 목록','퇴사예정':'퇴사예정','퇴사자':'퇴사자','만료예정':'근로계약 만료','서류':'서류 체크','부서':'부서 관리','달력':'공유달력','연차현황':'연차현황','계정':'계정 관리','피복':'피복 관리','연동':'가나안요청 연동','서명':'서명 만들기'};
function siteOf(e){return e?.site||'세원'}
function inCompany(e){return currentCompany==='전체'||siteOf(e)===currentCompany}
function companyLabel(){return currentCompany==='전체'?'전체 회사':currentCompany}
function tabLabel(){return TAB_LABELS[currentTab]||currentTab}
function updateHeader(){
  if($('pageTitle'))$('pageTitle').textContent=tabLabel();
  if($('subtitle'))$('subtitle').textContent=`${companyLabel()} · ${today().getFullYear()}년 ${today().getMonth()+1}월 ${today().getDate()}일`;
  document.querySelectorAll('#companyChips [data-company]').forEach(b=>b.classList.toggle('active',b.dataset.company===currentCompany));
  if($('companySelect'))$('companySelect').value=currentCompany;
}
function setCompany(c){if(lockedSite)c=lockedSite;currentCompany=COMPANIES.includes(c)?c:'전체';if(currentTab==='달력')renderCalendar();else if(currentTab==='연차현황')renderAnnualLeaveHistory();else render();updateHeader()}
function hideErpViews(){['dashboardView','docsView','deptView','accountsView','uniformView','linkView','signView'].forEach(id=>show($(id),false));show($('toolbarSection'),true)}
function showErpView(id){
  hideErpViews();
  show($('statsSection'),false);show($('employeeSection'),false);show($('toolbarSection'),false);
  show($('calendarView'),false);show($('annualLeaveHistoryView'),false);show($('addBtn'),true);
  show($(id),true);
}
function contractStageCount(){return $('site')?.value==='대한전선'?4:5}
function updateContractRuleHelp(){
  const el=$('contractRuleHelp');if(!el)return;
  el.textContent=$('site').value==='대한전선'
    ?'대한전선 규칙: 1차 1개월 → 2차 1개월 → 3차 1개월 → 4차 9개월 (입사일 기준 총 1년, 4차 종료일 = 입사 1년 전날). 필요한 차수만 골라 자동생성할 수 있습니다.'
    :'입사일 기준으로 필요한 차수만 골라 자동생성할 수 있습니다. 1차 1주 → 2~4차 각 1개월 → 5차는 4차 종료 다음날부터 입사일 기준 1년이 되는 전날까지 자동 계산됩니다.';
}
function renderContractStageButtons(n){
  const box=$('contractStageButtons');if(!box)return;
  box.innerHTML=Array.from({length:n},(_,i)=>`<button type="button" data-contract-stage="${i+1}">${i+1}차</button>`).join('')+`<button type="button" data-contract-stage="all" class="primary">1~${n}차 전체</button>`;
}
function setDocFields(e){
  const ready=docV8Ready();
  [['docId','doc_id_submitted'],['docBank','doc_bank_submitted'],['usesDorm','uses_dorm'],['docDorm','doc_dorm_submitted']].forEach(([id,k])=>{const el=$(id);if(el){el.disabled=!ready;el.checked=!!e?.[k]}});
  fillDeptDatalist();
}
// 근로계약서: 현재(또는 다음) 계약 차수에 실제 작성일이 있으면 완료
function contractDocStatus(e){
  const info=currentContractInfo(e);
  if(!info.row)return {ok:false,label:'계약 없음',cls:'no'};
  if(info.row.actual_write_date)return {ok:true,label:`${info.seq||''}차 완료`,cls:'ok'};
  return {ok:false,label:`${info.seq||''}차 미작성`,cls:'no'};
}
function missingDocs(e){
  const m=[];
  if(!contractDocStatus(e).ok)m.push('근로계약서');
  if(docV8Ready()){if(!idDocOk(e))m.push('신분증');if(!bankDocOk(e))m.push('통장사본');if(e.uses_dorm&&!e.doc_dorm_submitted)m.push('기숙사 계약서')}
  return m;
}
function activeInCompany(){return employees.filter(e=>!isTerminated(e)).filter(inCompany)}
function updateNavDocCount(){
  const el=$('navDocCount');if(!el)return;
  const n=activeInCompany().filter(e=>missingDocs(e).length).length;
  el.textContent=n;show(el,n>0);
}
function addDaysKey(key,n){return addDaysISO(key,n)}
function mdLabel(key){const p=isoParts(key);if(!p)return key||'-';const d=new Date(p.y,p.m-1,p.d);return `${p.m}/${p.d} (${'일월화수목금토'[d.getDay()]})`}
function miniTable(head,rows,empty){
  if(!rows.length)return `<div class="dash-empty">${esc(empty)}</div>`;
  return `<table class="erp-table compact"><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function eventInCompany(ev){return currentCompany==='전체'||!ev.site||ev.site==='전체'||ev.site===currentCompany}
function weekEvents(){
  const start=localDateKey(today()), end=addDaysKey(start,6);
  const list=[];
  calendarEvents.forEach(ev=>{const s=ev.start_date,e=ev.end_date||ev.start_date;if(s&&s<=end&&e>=start&&eventInCompany(ev))list.push({...ev,date:s<start?start:s})});
  [...autoHireEvents(),...autoTerminationEvents()].forEach(ev=>{if(ev.start_date>=start&&ev.start_date<=end&&eventInCompany(ev))list.push({...ev,date:ev.start_date})});
  employees.filter(e=>!isTerminated(e)&&inCompany(e)).forEach(e=>{
    const mmdd=residentBirthdayMMDD(e.resident_no);if(!mmdd)return;
    [today().getFullYear(),today().getFullYear()+1].forEach(y=>{const d=birthdayDateForYear(mmdd,y);if(d&&d>=start&&d<=end)list.push({event_type:'생일',title:`${e.name} 생일`,date:d,employee_id:e.id,site:siteOf(e)})});
  });
  return list.sort((a,b)=>a.date.localeCompare(b.date)||String(a.title||'').localeCompare(String(b.title||''),'ko'));
}
const TYPE_BADGE={'연차':'bl','휴가':'bl','입사':'ok','퇴사':'no','생일':'gy','계약만료':'wt','결근':'no','지각/조퇴':'wt','면접':'gy','기타':'gy'};
function renderDashboard(){
  if(currentTab!=='대시보드')return;
  showErpView('dashboardView');
  const act=activeInCompany();
  const todayKey=localDateKey(today()), monthKey=todayKey.slice(0,7);
  const inMonth=k=>String(k||'').slice(0,7)===monthKey;
  const expiring=act.filter(isExpiring);
  const docsMissing=act.filter(e=>missingDocs(e).length);
  $('dashActive').textContent=act.length;
  $('dashHireMonth').textContent=employees.filter(inCompany).filter(e=>inMonth(e.hire_date)).length;
  $('dashExitMonth').textContent=employees.filter(inCompany).filter(e=>inMonth(e.termination_date)).length;
  $('dashExpiring').textContent=expiring.length;
  $('dashDocs').textContent=docsMissing.length;

  // 부서별 인원
  const dept=new Map();act.forEach(e=>{const k=String(e.department||'').trim()||'미지정';dept.set(k,(dept.get(k)||0)+1)});
  const depts=[...dept.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ko'));
  const max=Math.max(1,...depts.map(d=>d[1]));
  $('dashDeptTotal').textContent=`재직 ${act.length}명`;
  $('dashDept').innerHTML=depts.length?depts.map(([k,n],i)=>`<div class="dash-bar${i>3?' light':''}"><span>${esc(k)}</span><i style="width:${Math.max(4,Math.round(n/max*100))}%"></i><b>${n}</b></div>`).join(''):'<div class="dash-empty">재직자가 없습니다.</div>';

  // 이번 주
  const week=weekEvents();
  const weekLeave=new Set(week.filter(e=>e.event_type==='연차').map(e=>e.employee_id||e.title)).size;
  const weekBirth=week.filter(e=>e.event_type==='생일').length;
  const upcomingHire=employees.filter(inCompany).filter(e=>e.hire_date&&e.hire_date>todayKey);
  const exitSched=employees.filter(inCompany).filter(isExitScheduled);
  const todo=[
    ['wt','계약',`근로계약 만료 7일 이내 <b>${expiring.length}명</b>`,'만료예정'],
    ['gy','생일',`이번 주 생일 <b>${weekBirth}명</b>`,'달력'],
    ['bl','연차',`이번 주 연차 사용 <b>${weekLeave}명</b>`,'달력'],
    ['wt','서류',`서류 미제출 <b>${docsMissing.length}명</b>`,'서류'],
    ['bl','입사',`입사 예정 <b>${upcomingHire.length}명</b>${upcomingHire.length?` (${esc(upcomingHire.map(e=>e.hire_date.slice(5).replace('-','/')).sort()[0])}부터)`:''}`,'직원'],
    ['no','퇴사',`퇴사 예정 <b>${exitSched.length}명</b>`,'퇴사예정']
  ];
  $('dashTodo').innerHTML=todo.map(([c,tag,txt,go])=>`<li><button type="button" data-goto="${go}"><span class="b ${c}">${tag}</span> ${txt}</button></li>`).join('');

  $('dashWeek').innerHTML=miniTable(['날짜','구분','내용'],week.slice(0,12).map(ev=>`<tr${ev.employee_id?` data-emp="${esc(ev.employee_id)}"`:''}><td>${esc(mdLabel(ev.date))}</td><td><span class="b ${TYPE_BADGE[ev.event_type]||'gy'}">${esc(ev.event_type)}</span></td><td>${esc(ev.title||'')}${ev.event_type==='연차'&&ev.leave_days?` · ${esc(formatLeaveDays(Number(ev.leave_days)))}`:''}</td></tr>`),'이번 주 일정이 없습니다.');

  const soon=act.map(e=>({e,c:currentContractInfo(e)})).filter(x=>x.c.days!==null&&x.c.days>=0&&x.c.days<=30).sort((a,b)=>a.c.days-b.c.days);
  $('dashContracts').innerHTML=miniTable(['성명','부서','차수','만료일','남은 날'],soon.slice(0,10).map(({e,c})=>`<tr data-emp="${esc(e.id)}"><td>${esc(e.name)}</td><td>${esc(e.department||'-')}</td><td>${c.seq?esc(c.seq+'차'):'-'}${c.row?.contract_kind?` <small>${esc(c.row.contract_kind)}</small>`:''}</td><td>${esc(mdLabel(c.end))}</td><td><span class="b ${c.days<=7?'wt':'gy'}">${c.days===0?'오늘':c.days+'일'}</span></td></tr>`),'30일 안에 끝나는 계약이 없습니다.');

  const leaves=act.map(e=>{try{return {e,i:annualLeaveInfoForEmployee(e)}}catch(err){return null}}).filter(x=>x&&x.i&&Number(x.i.totalAvailable)>0).sort((a,b)=>a.i.remaining-b.i.remaining);
  $('dashLeave').innerHTML=miniTable(['성명','부서','보유','사용','잔여'],leaves.slice(0,6).map(({e,i})=>`<tr data-emp="${esc(e.id)}"><td>${esc(e.name)}</td><td>${esc(e.department||'-')}</td><td>${esc(formatLeaveDays(i.totalAvailable))}</td><td>${esc(formatLeaveDays(i.used))}</td><td><span class="b ${i.remaining<=1?'no':i.remaining<=2?'wt':'gy'}">${esc(formatLeaveDays(i.remaining))}</span></td></tr>`),'연차가 발생한 직원이 없습니다.');

  const from=addDaysKey(todayKey,-30), to=addDaysKey(todayKey,30);
  const recent=[];
  employees.filter(inCompany).forEach(e=>{
    if(e.hire_date&&e.hire_date>=from&&e.hire_date<=to)recent.push({e,kind:'입사',date:e.hire_date});
    if(e.termination_date&&e.termination_date>=from&&e.termination_date<=to)recent.push({e,kind:'퇴사',date:e.termination_date});
  });
  recent.sort((a,b)=>b.date.localeCompare(a.date));
  $('dashRecent').innerHTML=miniTable(['성명','구분','부서','날짜'],recent.slice(0,8).map(r=>`<tr data-emp="${esc(r.e.id)}"><td>${esc(r.e.name)}</td><td><span class="b ${r.kind==='입사'?'ok':'no'}">${r.kind}</span></td><td>${esc(r.e.department||'-')}</td><td>${esc(mdLabel(r.date))}${r.date>todayKey?' 예정':''}</td></tr>`),'최근 입·퇴사가 없습니다.');
}
function renderDocsView(){
  if(currentTab!=='서류')return;
  showErpView('docsView');
  const ready=docV8Ready();
  show($('docsSetupNotice'),!ready);
  const only=$('docsOnlyMissing').checked;
  const rows=activeInCompany().filter(e=>!only||missingDocs(e).length).sort((a,b)=>String(a.hire_date||'').localeCompare(String(b.hire_date||''))||a.name.localeCompare(b.name,'ko'));
  const box=(e,key,on='있음',off='없음')=>ready?`<label class="doc-toggle"><input type="checkbox" data-doc="${key}" data-id="${esc(e.id)}" ${e[key]?'checked':''}> <span class="b ${e[key]?'ok':'no'}">${e[key]?on:off}</span></label>`:'<span class="b gy">-</span>';
  const idCell=e=>ready?docPhotoCell(e,'id'):'<span class="b gy">-</span>';
  const dormCell=e=>ready?`<label class="doc-toggle"><input type="checkbox" data-doc="uses_dorm" data-id="${esc(e.id)}" ${e.uses_dorm?'checked':''}> <span class="b ${e.uses_dorm?'bl':'gy'}">${e.uses_dorm?'사용':'안 씀'}</span></label>`:'<span class="b gy">-</span>';
  $('docsTable').innerHTML=rows.length?rows.map(e=>{const c=contractDocStatus(e);return `<tr><td><button type="button" class="link-btn" data-emp="${esc(e.id)}">${esc(e.name)}</button></td><td>${esc(siteOf(e))}</td><td>${esc(e.department||'-')}</td><td>${esc(fmtDate(e.hire_date))}</td><td><button type="button" class="link-btn" data-emp="${esc(e.id)}"><span class="b ${c.cls}">${esc(c.label)}</span></button></td><td>${idCell(e)}</td><td>${ready?docPhotoCell(e,'bank'):'<span class="b gy">-</span>'}</td><td>${dormCell(e)}</td><td>${e.uses_dorm?box(e,'doc_dorm_submitted'):'<span class="muted">-</span>'}</td></tr>`}).join(''):`<tr><td colspan="9" class="dash-empty">${only?'서류가 모두 갖춰졌습니다.':'표시할 직원이 없습니다.'}</td></tr>`;
}
async function toggleDoc(id,key,checked){
  const {error}=await sb.from(EMP_TABLE).update({[key]:checked}).eq('id',id);
  if(error){alert('저장 실패: '+error.message);renderDocsView();return}
  const e=employees.find(x=>x.id===id);if(e)e[key]=checked;
  updateNavDocCount();renderDocsView();
}
// v009: 부서 관리 — 이름 칸 바로 고치기, ▲▼ 순서, 묶음 고르기, 칸에서 바로 추가
function deptOrder(site,name){const r=deptRows.find(x=>x.site===site&&x.name===name);return r&&r.sort_no?r.sort_no:9999}
function deptSections(){
  const groups=new Map();const add=(site,dept,e)=>{const k=`${site}|${dept}`;if(!groups.has(k))groups.set(k,[]);if(e)groups.get(k).push(e)};
  activeInCompany().forEach(e=>add(siteOf(e),String(e.department||'').trim(),e));
  deptRows.filter(r=>(currentCompany==='전체'||r.site===currentCompany)).forEach(r=>add(r.site,r.name,null));
  const sec=new Map();
  for(const [k,arr] of groups){const [site,name]=k.split('|');const parent=name?deptParent(site,name):(site==='대한전선'?'산업전선':'');const sk=`${site}|${parent}`;if(!sec.has(sk))sec.set(sk,{site,parent,depts:[]});sec.get(sk).depts.push({site,name,arr})}
  if(currentCompany!=='세원'&&!lockedSite||lockedSite==='대한전선')['산업전선','포장'].forEach(p=>{if(currentCompany==='세원')return;const sk=`대한전선|${p}`;if(!sec.has(sk))sec.set(sk,{site:'대한전선',parent:p,depts:[]})});
  const list=[...sec.values()].sort((a,b)=>a.site.localeCompare(b.site,'ko')||(a.parent==='포장')-(b.parent==='포장'));
  list.forEach(x=>x.depts.sort((a,b)=>(!a.name)-(!b.name)||deptOrder(a.site,a.name)-deptOrder(b.site,b.name)||a.name.localeCompare(b.name,'ko')));
  return list;
}
let deptSortables=[];
function renderDeptView(){
  if(currentTab!=='부서')return;
  showErpView('deptView');show($('addBtn'),false);
  show($('deptNotice'),!deptReady);
  deptSortables.forEach(x=>{try{x.destroy()}catch(e){}});deptSortables=[];
  const secs=deptSections();
  $('deptList').innerHTML=secs.length?secs.map(sec=>{const total=sec.depts.reduce((n,d)=>n+d.arr.length,0);
    return `<div class="dept-group" data-site="${esc(sec.site)}" data-parent="${esc(sec.parent)}"><div class="dept-group-title"><b>${esc(sec.parent||sec.site)}</b>${sec.parent&&currentCompany==='전체'?`<small>${esc(sec.site)}</small>`:''}<span>${total}명</span></div><div class="dept-rows">`+
    sec.depts.map(d=>{const mem=d.arr.sort((a,b)=>a.name.localeCompare(b.name,'ko'));
      return `<div class="dept-row${d.name?'':' no-drag'}" data-site="${esc(d.site)}" data-name="${esc(d.name)}">`+
      `<span class="dept-grip" aria-hidden="true">${d.name?'⋮⋮':''}</span><div class="dept-main"><div class="dept-top">`+
      (d.name?`<input class="dept-name" value="${esc(d.name)}" data-old="${esc(d.name)}" maxlength="40" enterkeyhint="done" aria-label="부서 이름 (눌러서 고치기)">`:`<span class="dept-name-none">부서 미지정</span>`)+
      `<span class="dept-n">${d.arr.length}</span>${d.name&&!d.arr.length?`<button type="button" class="dept-del">지우기</button>`:''}</div>`+
      `<div class="dept-people" data-site="${esc(d.site)}" data-dept="${esc(d.name)}">${mem.map(e=>`<button type="button" class="dept-person" data-emp="${esc(e.id)}" data-pid="${esc(e.id)}">${esc(e.name)}</button>`).join('')}</div></div></div>`}).join('')+
    `</div><form class="dept-add"><input placeholder="+ 새 부서 이름 적고 엔터" maxlength="40" enterkeyhint="done"><button type="submit">추가</button></form></div>`}).join(''):'<div class="empty">재직자가 없습니다.</div>';
  if(!window.Sortable)return;
  const touch={delay:180,delayOnTouchOnly:true,touchStartThreshold:6,animation:150,forceFallback:true,fallbackTolerance:4,fallbackOnBody:true};
  document.querySelectorAll('#deptList .dept-rows').forEach(el=>{const site=el.closest('.dept-group').dataset.site;
    deptSortables.push(Sortable.create(el,{...touch,group:{name:'dept-'+site,pull:true,put:true},draggable:'.dept-row:not(.no-drag)',filter:'input,button,.dept-people',preventOnFilter:false,ghostClass:'drag-ghost',chosenClass:'drag-chosen',
      onEnd:ev=>{if(ev.from===ev.to&&ev.oldIndex===ev.newIndex)return;const it=ev.item.dataset.name;setTimeout(()=>saveDeptDrag(ev.from,ev.to,it),80)}}))});
  document.querySelectorAll('#deptList .dept-people').forEach(el=>{
    deptSortables.push(Sortable.create(el,{...touch,group:'people-'+el.dataset.site,sort:false,ghostClass:'drag-ghost',chosenClass:'drag-chosen',
      onEnd:ev=>{if(ev.from===ev.to)return;const a=[ev.item.dataset.pid,ev.to.dataset.dept,ev.from.dataset.dept];setTimeout(()=>movePerson(...a),80)}}))});
}
async function saveDeptDrag(fromEl,toEl,movedName){
  if(!deptReady){deptToast('순서 바꾸기는 v008 SQL을 설치한 뒤 됩니다.',true);renderDeptView();return}
  const lists=[...new Set([fromEl,toEl])].map(el=>{const g=el.closest('.dept-group');return {site:g.dataset.site,parent:g.dataset.parent||null,names:[...el.querySelectorAll('.dept-row')].map(r=>r.dataset.name).filter(Boolean)}});
  const rows=lists.flatMap(l=>l.names.map((name,i)=>({site:l.site,name,parent:l.site==='대한전선'?l.parent:(deptRows.find(r=>r.site===l.site&&r.name===name)?.parent??null),sort_no:i+1})));
  rows.forEach(r=>{const x=deptRows.find(d=>d.site===r.site&&d.name===r.name);if(x){x.sort_no=r.sort_no;x.parent=r.parent}else deptRows.push({...r})});
  if(fromEl!==toEl&&movedName)deptToast(`'${movedName}' → ${lists[1].parent||lists[1].site}`)
  renderDeptView();
  const {error}=await sb.from('erp_departments').upsert(rows,{onConflict:'site,name'});
  if(error){deptToast('저장 실패: '+error.message,true);await loadDepartments();renderDeptView()}
}
async function movePerson(id,toDept,fromDept){
  const e=employees.find(x=>x.id===id);if(!e){renderDeptView();return}
  const {error}=await sb.from(EMP_TABLE).update({department:toDept||null}).eq('id',id);
  if(error){deptToast('옮기기 실패: '+error.message,true);renderDeptView();return}
  e.department=toDept||null;deptToast(`${e.name}: ${fromDept||'미지정'} → ${toDept||'미지정'}`);renderDeptView();
}
function deptToast(t,err){const el=$('deptMsg');if(!el)return;el.textContent=t;el.style.color=err?'#b91c1c':'';show(el,!!t);clearTimeout(deptToast._t);deptToast._t=setTimeout(()=>show(el,false),3500)}
async function saveDeptOrder(site,parent,names){
  const rows=names.map((name,i)=>({site,name,parent:site==='대한전선'?parent:(deptRows.find(r=>r.site===site&&r.name===name)?.parent??null),sort_no:i+1}));
  rows.forEach(r=>{const x=deptRows.find(d=>d.site===r.site&&d.name===r.name);if(x){x.sort_no=r.sort_no;x.parent=r.parent}else deptRows.push({...r})});
  renderDeptView();
  const {error}=await sb.from('erp_departments').upsert(rows,{onConflict:'site,name'});
  if(error){deptToast('순서 저장 실패: '+error.message,true);await loadDepartments();renderDeptView()}
}
async function moveDept(row,dir){
  const g=row.closest('.dept-group');const names=[...g.querySelectorAll('.dept-row')].map(r=>r.dataset.name).filter(Boolean);
  const i=names.indexOf(row.dataset.name),j=i+dir;if(i<0||j<0||j>=names.length)return;[names[i],names[j]]=[names[j],names[i]];
  await saveDeptOrder(g.dataset.site,g.dataset.parent,names);
  const again=[...$('deptList').querySelectorAll('.dept-row')].find(r=>r.dataset.site===g.dataset.site&&r.dataset.name===names[j]);again?.querySelector(`[data-move="${dir}"]:not([disabled])`)?.focus();
}
async function renameDept(site,oldName,newName){
  newName=String(newName||'').trim();if(!newName||newName===oldName){renderDeptView();return}
  const targets=employees.filter(e=>siteOf(e)===site&&String(e.department||'').trim()===oldName);
  const exists=deptRows.some(r=>r.site===site&&r.name===newName)||employees.some(e=>siteOf(e)===site&&String(e.department||'').trim()===newName);
  if(exists&&!confirm(`'${newName}' 부서가 이미 있습니다. '${oldName}' ${targets.length}명을 '${newName}'(으)로 합칠까요?`)){renderDeptView();return}
  if(targets.length){const {error}=await sb.from(EMP_TABLE).update({department:newName}).in('id',targets.map(e=>e.id));if(error){deptToast('바꾸기 실패: '+error.message,true);renderDeptView();return}targets.forEach(e=>e.department=newName)}
  if(deptReady){const old=deptRows.find(r=>r.site===site&&r.name===oldName);
    if(exists){if(old){const {error}=await sb.from('erp_departments').delete().eq('site',site).eq('name',oldName);if(error)console.warn('빈 부서 지우기 실패',error)}}
    else if(old){const {error}=await sb.from('erp_departments').update({name:newName}).eq('site',site).eq('name',oldName);if(error)console.warn('부서 표 이름 변경 실패',error)}
    else{const {error}=await sb.from('erp_departments').insert({site,name:newName,parent:site==='대한전선'?deptParent(site,oldName):null,sort_no:9999});if(error)console.warn(error)}}
  deptToast(`'${oldName}' → '${newName}' (${targets.length}명)`);
  await loadDepartments();render();
}

// ----- 엑셀 가져오기 -----
const IMPORT_FIELD_LABELS={site:'소속',name:'성명',gender:'성별',department:'부서',hourly_wage:'시급',resident_no:'주민번호',phone:'전화번호',address:'주소',hire_date:'입사일',termination_date:'퇴사일',bank:'은행',account_no:'계좌번호',account_holder:'예금주',interview_route:'면접경로',visa:'비자',tax_type:'공제구분',notes:'특이사항',doc_pledge_submitted:'서약서',doc_resume_submitted:'이력서'};
function cellText(v){
  if(v===null||v===undefined)return '';
  if(v instanceof Date)return v;
  if(typeof v==='object'){
    if(v.richText)return v.richText.map(x=>x.text).join('');
    if('result' in v)return cellText(v.result);
    if(v.text!==undefined)return cellText(v.text);
    if(v.hyperlink)return String(v.hyperlink);
    return '';
  }
  return v;
}
function normHeader(s){return String(s||'').replace(/\(.*?\)/g,'').replace(/\s+/g,'').trim()}
function toDateKey(v){
  if(v===null||v===undefined||v==='')return null;
  if(v instanceof Date&&!isNaN(v))return `${v.getUTCFullYear()}-${String(v.getUTCMonth()+1).padStart(2,'0')}-${String(v.getUTCDate()).padStart(2,'0')}`;
  if(typeof v==='number'&&v>20000&&v<80000){const d=new Date(Date.UTC(1899,11,30)+v*86400000);return toDateKey(d)}
  const m=String(v).trim().match(/^(\d{2,4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if(!m)return null;
  let y=Number(m[1]);if(y<100)y+=2000;
  const mo=Number(m[2]),d=Number(m[3]);const probe=new Date(y,mo-1,d);
  if(probe.getMonth()!==mo-1)return null;
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function digitsOf(v){return String(v||'').replace(/\D/g,'')}
function fmtPhone(v){const d=digitsOf(v);if(/^1\d{9}$/.test(d))return fmtPhone('0'+d);if(/^010\d{8}$/.test(d))return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;return String(v||'').trim()}
function fmtResident(v){const d=digitsOf(v);if(d.length===13)return `${d.slice(0,6)}-${d.slice(6)}`;return String(v||'').replace(/\s+/g,'').trim()}
function genderFromResident(v){const d=digitsOf(v);if(d.length<7)return null;const g=Number(d[6]);return [1,3,5,7].includes(g)?'남':[2,4,6,8].includes(g)?'여':null}
function boolCell(v){const s=String(v??'').trim();if(!s)return null;if(/^(o|○|●|y|yes|v|✓|✔|완료|제출|있음|true)$/i.test(s))return true;if(/^(x|×|n|no|미제출|없음|false)$/i.test(s))return false;return null}
const HEADER_MAP={'성명':'name','이름':'name','성별':'gender','성별/나이':'gender','소속':'site_or_dept','회사':'site','부서':'department','시급':'hourly_wage','주민번호':'resident_no','주민등록번호':'resident_no','전화번호':'phone','연락처':'phone','주소':'address','입사일':'hire_date','퇴사일':'termination_date','은행':'bank','계좌번호':'account_no','예금주':'account_holder','면접경로':'interview_route','비자':'visa','공제구분':'tax_type','4대보험/3.3%':'tax_type','서약서':'doc_pledge_submitted','이력서':'doc_resume_submitted','재직상태':'employment_status','비고':'note:비고','특이사항':'note:특이사항','소개비공제':'note:소개비 공제','퇴사사유':'note:퇴사사유','기숙사':'note:기숙사'};
async function parseImportWorkbook(file){
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  let sheets=wb.worksheets.filter(ws=>/재직|퇴사/.test(ws.name));
  if(!sheets.length)sheets=wb.worksheets.slice(0,1);
  const out=[];
  for(const ws of sheets){
    let headerRow=null,map={};
    for(let r=1;r<=Math.min(ws.rowCount,25)&&!headerRow;r++){
      const row=ws.getRow(r);const m={};
      row.eachCell({includeEmpty:false},(c,col)=>{const h=normHeader(cellText(c.value));if(HEADER_MAP[h])m[col]=HEADER_MAP[h]});
      if(Object.values(m).includes('name'))headerRow=r,map=m;
    }
    if(!headerRow)continue;
    const exitSheet=/퇴사/.test(ws.name);
    for(let r=headerRow+1;r<=ws.rowCount;r++){
      const row=ws.getRow(r);const rec={notes:[]};
      Object.entries(map).forEach(([col,key])=>{
        const raw=cellText(row.getCell(Number(col)).value);
        if(raw===''||raw===null)return;
        if(key.startsWith('note:')){const s=String(raw).trim();if(s)rec.notes.push(`${key.slice(5)}: ${s}`);return}
        rec[key]=raw;
      });
      const name=String(rec.name||'').trim();
      if(!name||name==='성명'||/합계|총\s*원|소계/.test(name))continue;
      out.push({sheet:ws.name,rowNo:r,exitSheet,rec});
    }
  }
  return out;
}
function normalizeImportRecord(item,defaultSite){
  const r=item.rec,o={};
  o.name=String(r.name).trim();
  const so=String(r.site_or_dept??'').trim();
  if(r.site&&COMPANIES.includes(String(r.site).trim()))o.site=String(r.site).trim();
  else if(COMPANIES.includes(so))o.site=so;
  else o.site=defaultSite;
  if(r.department!==undefined)o.department=String(r.department).trim()||null;
  else if(so&&!COMPANIES.includes(so))o.department=so;
  if(r.resident_no!==undefined)o.resident_no=fmtResident(r.resident_no)||null;
  const g=String(r.gender??'').trim();
  o.gender=/^(남|여)$/.test(g)?g:genderFromResident(o.resident_no)||undefined;
  if(r.hourly_wage!==undefined){const n=Number(String(r.hourly_wage).replace(/[^\d.]/g,''));if(n>0)o.hourly_wage=n}
  if(r.phone!==undefined)o.phone=fmtPhone(r.phone)||null;
  ['address','bank','account_no','account_holder','interview_route','visa'].forEach(k=>{if(r[k]!==undefined){const s=String(r[k]).trim();if(s)o[k]=s}});
  if(r.tax_type!==undefined&&['4대보험','3.3%'].includes(String(r.tax_type).trim()))o.tax_type=String(r.tax_type).trim();
  const hd=toDateKey(r.hire_date);if(hd)o.hire_date=hd;
  const td=toDateKey(r.termination_date);if(td)o.termination_date=td;
  if(docColumnsReady){const p=boolCell(r.doc_pledge_submitted),s=boolCell(r.doc_resume_submitted);if(p!==null)o.doc_pledge_submitted=p;if(s!==null)o.doc_resume_submitted=s}
  if(r.notes.length)o._notes=r.notes.join('\n');
  Object.keys(o).forEach(k=>o[k]===undefined&&delete o[k]);
  return o;
}
function findImportMatch(o,used){
  const pool=employees.filter(e=>siteOf(e)===o.site&&!used.has(e.id));
  const rd=digitsOf(o.resident_no);
  if(rd.length===13){const m=pool.find(e=>digitsOf(e.resident_no)===rd);if(m)return m}
  const same=pool.filter(e=>String(e.name||'').trim()===o.name);
  if(!same.length)return null;
  const pd=digitsOf(o.phone);
  if(pd){const m=same.find(e=>digitsOf(e.phone)===pd);if(m)return m}
  if(o.hire_date){const m=same.find(e=>e.hire_date===o.hire_date);if(m)return m}
  return same.length===1&&(!rd||!digitsOf(same[0].resident_no))?same[0]:null;
}
function sameValue(k,a,b){
  if(k==='hourly_wage')return Number(a||0)===Number(b||0);
  if(k==='phone'||k==='resident_no'||k==='account_no')return digitsOf(a)===digitsOf(b);
  if(k.startsWith('doc_'))return !!a===!!b;
  return String(a??'').trim()===String(b??'').trim();
}
function buildImportPlan(items,defaultSite){
  const used=new Set(),plan=[];
  for(const it of items){
    const o=normalizeImportRecord(it,defaultSite);
    const m=findImportMatch(o,used);
    if(!m){plan.push({kind:'new',o,it});continue}
    used.add(m.id);
    const changes={};
    Object.entries(o).forEach(([k,v])=>{if(k.startsWith('_')||k==='site')return;if(v===null||v==='')return;if(!sameValue(k,m[k],v))changes[k]=v});
    if(o._notes){const cur=String(m.notes||'');const add=o._notes.split('\n').filter(l=>!cur.includes(l.replace(/^[^:]+:\s*/,'')));if(add.length)changes.notes=(cur?cur+'\n':'')+add.join('\n')}
    plan.push({kind:Object.keys(changes).length?'update':'same',o,it,emp:m,changes});
  }
  return plan;
}
function renderImportPlan(plan){
  const n=k=>plan.filter(p=>p.kind===k).length;
  $('importSummary').innerHTML=`<span class="b ok">새 직원 ${n('new')}명</span><span class="b wt">수정 ${n('update')}명</span><span class="b gy">변경 없음 ${n('same')}명</span>`;
  show($('importSummary'),true);
  const fmt=(k,v)=>k.startsWith('doc_')?(v?'O':'X'):String(v??'');
  const rows=plan.filter(p=>p.kind!=='same').map(p=>{
    const detail=p.kind==='new'
      ?`${esc(p.o.department||'')} · 입사 ${esc(p.o.hire_date||'-')}${p.o.termination_date?` · 퇴사 ${esc(p.o.termination_date)}`:''}`
      :Object.entries(p.changes).map(([k,v])=>`<div><b>${esc(IMPORT_FIELD_LABELS[k]||k)}</b> ${esc(k==='notes'?'(내용 추가)':fmt(k,p.emp[k])||'빈칸')} → ${esc(k==='notes'?'':fmt(k,v))}</div>`).join('');
    return `<tr><td><span class="b ${p.kind==='new'?'ok':'wt'}">${p.kind==='new'?'신규':'수정'}</span></td><td>${esc(p.o.name)}</td><td>${esc(p.o.site)}</td><td>${esc(p.it.sheet)} ${p.it.rowNo}행</td><td class="import-detail">${detail}</td></tr>`;
  });
  $('importPreview').innerHTML=rows.length?`<div class="table-wrap"><table class="erp-table compact"><thead><tr><th>구분</th><th>성명</th><th>소속</th><th>엑셀 위치</th><th>내용</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`:'<div class="dash-empty">앱과 엑셀 내용이 같습니다. 바꿀 것이 없습니다.</div>';
  $('importApply').disabled=!rows.length;
}
async function onImportFile(){
  const f=$('importFile').files[0];importPlan=null;$('importApply').disabled=true;
  if(!f)return;
  $('importFileName').textContent=f.name;
  $('importPreview').innerHTML='<div class="dash-empty">엑셀을 읽는 중...</div>';
  try{
    if(!window.ExcelJS)throw new Error('엑셀 기능을 불러오지 못했습니다. 인터넷 연결 후 다시 시도해주세요.');
    const items=await parseImportWorkbook(f);
    if(!items.length)throw new Error("'성명' 칸이 있는 표를 찾지 못했습니다.");
    importPlan=buildImportPlan(items,$('importSite').value);
    renderImportPlan(importPlan);
  }catch(e){$('importPreview').innerHTML=`<div class="error">${esc(e.message)}</div>`;show($('importSummary'),false)}
}
async function applyImport(){
  if(!importPlan)return;
  const todo=importPlan.filter(p=>p.kind!=='same');
  if(!todo.length||!confirm(`새 직원 ${todo.filter(p=>p.kind==='new').length}명 추가, ${todo.filter(p=>p.kind==='update').length}명 수정합니다. 진행할까요?`))return;
  const btn=$('importApply');btn.disabled=true;
  let ok=0;const fails=[];
  const {data:{user}}=await sb.auth.getUser();
  for(const p of todo){
    btn.textContent=`적용 중... ${ok+fails.length+1}/${todo.length}`;
    try{
      if(p.kind==='new'){
        const obj={...p.o};delete obj._notes;
        obj.id=crypto.randomUUID();obj.notes=p.o._notes||null;obj.created_by=user?.id||null;
        obj.employment_status=(obj.termination_date&&daysUntil(obj.termination_date)<=0)?'퇴사':'재직';
        const sched=obj.hire_date?buildStandardContractSchedule(obj.hire_date,obj.site):[];
        const sum=contractSummaryDates(sched);obj.contract_start_date=sum.start;obj.contract_end_date=sum.end;
        const {error}=await sb.from(EMP_TABLE).insert(obj);if(error)throw error;
        if(sched.length){const {error:hErr}=await sb.from(CONTRACT_TABLE).insert(sched.map(r=>({...r,employee_id:obj.id,status:'예정'})));if(hErr)console.warn('계약 이력 생성 실패',hErr)}
      }else{
        const ch={...p.changes};
        if('termination_date' in ch)ch.employment_status=daysUntil(ch.termination_date)<=0?'퇴사':'재직';
        const {error}=await sb.from(EMP_TABLE).update(ch).eq('id',p.emp.id);if(error)throw error;
      }
      ok++;
    }catch(e){fails.push(`${p.o.name}: ${e.message}`)}
  }
  btn.textContent='적용하기';
  await loadEmployees();
  alert(`완료: ${ok}건 적용${fails.length?`\n실패 ${fails.length}건\n${fails.slice(0,8).join('\n')}`:''}`);
  closeImport();
}
function openImport(){importPlan=null;$('importFile').value='';$('importFileName').textContent='선택된 파일 없음';$('importPreview').innerHTML='';show($('importSummary'),false);$('importApply').disabled=true;$('importSite').value=currentCompany!=='전체'?currentCompany:'대한전선';show($('importModal'),true)}
function closeImport(){show($('importModal'),false);importPlan=null}

function initErp(){
  document.querySelectorAll('#companyChips [data-company]').forEach(b=>b.onclick=()=>setCompany(b.dataset.company));
  $('companySelect').onchange=e=>setCompany(e.target.value);
  $('appView').addEventListener('click',e=>{
    const cc=e.target.closest('[data-company-card]');if(cc){setCompany(cc.dataset.companyCard);if(!['직원','퇴사예정','퇴사자','만료예정'].includes(currentTab))goTab('직원');return}
    const cf=e.target.closest('[data-clear-filter]');if(cf){listFilter='';render();return}
    const go=e.target.closest('[data-goto]');if(go){listFilter=go.dataset.filter||'';goTab(go.dataset.goto);return}
    const emp=e.target.closest('[data-emp]');if(emp&&!e.target.closest('input,.settle-check')){openEdit(emp.dataset.emp);return}
  });
  $('docsTable').addEventListener('change',e=>{const c=e.target.closest('[data-doc]');if(c)toggleDoc(c.dataset.id,c.dataset.doc,c.checked)});
  $('docsOnlyMissing').onchange=renderDocsView;
  $('bulkIdBtn').onclick=openBulkId;$('bulkIdClose').onclick=$('bulkIdCancel').onclick=()=>show($('bulkIdModal'),false);$('bulkIdFiles').onchange=onBulkIdFiles;document.querySelectorAll('input[name="bulkKind"]').forEach(x=>x.onchange=()=>{if($('bulkIdFiles').files.length)onBulkIdFiles({target:$('bulkIdFiles')})});$('bulkIdGo').onclick=runBulkId;
  $('docsTable').addEventListener('click',e=>{const mb=e.target.closest('[data-docmenu]');if(mb){e.stopPropagation();openDocMenu(mb);return}const v=e.target.closest('[data-docview]');if(v)viewDocPhoto(v.dataset.id,v.dataset.docview)});
  $('docMenu').addEventListener('click',e=>{const b=e.target.closest('[data-act]');const m=$('docMenu');if(!b){if(e.target===m)closeDocMenu();return}const {id,kind}=m.dataset;closeDocMenu();
    if(b.dataset.act==='cam'||b.dataset.act==='pick')startDocShot(b.dataset.act,id,kind);else if(b.dataset.act==='view')viewDocPhoto(id,kind)});
  document.addEventListener('click',e=>{if(!e.target.closest('#docMenu')&&!e.target.closest('[data-docmenu]'))closeDocMenu()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDocMenu()});
  $('docCamInput').onchange=onDocShotFile;$('docPickInput').onchange=onDocShotFile;
  $('site').addEventListener('change',updateContractRuleHelp);
  if($('importBtn'))$('importBtn').onclick=openImport;$('importClose').onclick=closeImport;$('importCancel').onclick=closeImport;
  $('importFile').onchange=onImportFile;$('importApply').onclick=applyImport;
  $('importSite').onchange=()=>{if($('importFile').files[0])onImportFile()};
  $('importModal').addEventListener('click',e=>{if(e.target===$('importModal'))closeImport()});
  updateHeader();
}

// ----- v002: 직원 목록 카드/표 전환 -----
function readPref(k,d){try{return localStorage.getItem(k)||d}catch(e){return d}}
function writePref(k,v){try{localStorage.setItem(k,v)}catch(e){}}
let listView=readPref('erp_list_view','card'), listSort='dept', showSum=readPref('erp_list_sum','0')==='1', lockedSite=null;
function residentInfo(v){const d=digitsOf(v);if(d.length<7)return {age:null,foreign:false};const c=Number(d[6]);const base=[1,2,5,6].includes(c)?1900:[3,4,7,8].includes(c)?2000:1800;return {age:today().getFullYear()-(base+Number(d.slice(0,2))),foreign:[5,6,7,8].includes(c)}}
function isForeign(e){return !!String(e.visa||'').trim()||residentInfo(e.resident_no).foreign}
// v009: 부서 표시 '산업전선/산전', 매니저는 항상 맨 위
function isManager(e){const d=String(e.department||'');return /매니저/.test(d)||(siteOf(e)==='대한전선'&&/사무/.test(d))} // v017: 대한전선은 사무도 맨 위 묶음
function topGroupName(e){return siteOf(e)==='대한전선'?'매니저/사무':'매니저'}
function deptLabel(e){const d=String(e.department||'').trim();if(siteOf(e)!=='대한전선')return d;const p=deptParent('대한전선',d);return d?(p?`${p}/${d}`:d):(p?`${p}/미지정`:'')}
function deptGroupLabel(e){if(isManager(e))return topGroupName(e);const l=deptLabel(e)||'부서 미지정';return currentCompany==='전체'?`${siteOf(e)} · ${l}`:l}
function deptSortKey(e){const d=siteOf(e)==='세원'?'':String(e.department||'').trim();const p=siteOf(e)==='대한전선'?deptParent('대한전선',d):'';const o=String(d?Math.min(deptOrder(siteOf(e),d),9999):9999).padStart(4,'0');return [isManager(e)?'0'+siteOf(e)+(/매니저/.test(String(e.department||''))?'a':'b'):'1',siteOf(e),p==='포장'?'2':'1',d?'0':'1',o,d].join('|')}
function sortPrefKey(){return 'erp_list_sort3_'+currentCompany}
function groupedByDept(a){return currentTab==='직원'&&listSort==='dept'&&!listFilter}
function bigGroupLabel(e){if(isManager(e))return currentCompany==='전체'&&siteOf(e)==='대한전선'?'대한전선 · 매니저/사무':topGroupName(e);const st=siteOf(e);if(st!=='대한전선')return st;const p=deptParent('대한전선',String(e.department||'').trim())||'산업전선';return currentCompany==='전체'?`대한전선 · ${p}`:p}
function subGroupLabel(e){if(isManager(e)||siteOf(e)==='세원')return '';return String(e.department||'').trim()||'부서 미지정'}
function withGroupHeads(a,row,head){if(!groupedByDept(a))return a.map(row).join('');const cb={},cs={};a.forEach(e=>{const b=bigGroupLabel(e),k=b+'|'+subGroupLabel(e);cb[b]=(cb[b]||0)+1;cs[k]=(cs[k]||0)+1});let out='',lb=null,ls=null,i=0;
  a.forEach(e=>{const b=bigGroupLabel(e),sg=subGroupLabel(e);if(b!==lb){out+=head(b,cb[b],'big');lb=b;ls=null}if(sg&&sg!==ls){out+=head(sg,cs[b+'|'+sg],'sub');ls=sg}out+=row(e,i++)});return out}
function sortList(a){
  if(currentTab==='퇴사자')return a; // 퇴사자는 항상 최근 퇴사일 순
  listSort=readPref(sortPrefKey(),currentCompany==='세원'?'hire':'dept');
  if(listSort==='dept')return [...a].sort((x,y)=>deptSortKey(x).localeCompare(deptSortKey(y))||String(x.hire_date||'').localeCompare(String(y.hire_date||''))||x.name.localeCompare(y.name,'ko'));
  if(listSort==='name')return [...a].sort((x,y)=>x.name.localeCompare(y.name,'ko'));
  if(currentTab==='직원')return [...a].sort((x,y)=>String(x.hire_date||'9999').localeCompare(String(y.hire_date||'9999'))||x.name.localeCompare(y.name,'ko'));
  return a;
}
function rosterSummary(a){
  const n=k=>a.filter(k).length;
  const items=[[a.length,'인원',''],[`${n(e=>e.gender==='남')} / ${n(e=>e.gender==='여')}`,'남 / 여',''],[n(isForeign),'외국인',''],[n(e=>!String(e.account_no||'').trim()),'계좌 미기재','warn'],[n(e=>!String(e.resident_no||'').trim()),'주민번호 미기재','warn'],[n(e=>e.hire_date&&e.hire_date>localDateKey(today())),'입사 예정','']];
  return items.map(([v,l,c])=>`<div class="${c&&v>0?c:''}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
}
function rosterRows(a){
  const docBadge=(ok,t)=>`<span class="dk${ok?' o':''}" title="${t} ${ok?'완료':'미제출'}">${t==='기숙사 계약서'?'기숙사':t}</span>`;
  const desk=withGroupHeads(a,(e,i)=>{const r=residentInfo(e.resident_no),c=currentContractInfo(e),cd=contractDocStatus(e);
    const ctr=c.days===null?'<span class="muted">없음</span>':`${c.seq?esc(c.seq)+'차 ':''}<span class="b ${c.days<0?'no':c.days<=7?'wt':'gy'}">${c.days<0?Math.abs(c.days)+'일 지남':c.days+'일'}</span>`;
    const docs=docBadge(cd.ok,'계약서')+(docV8Ready()?docBadge(idDocOk(e),'신분증')+docBadge(bankDocOk(e),bankKind(e)||'통장사본')+(e.uses_dorm?docBadge(!!e.doc_dorm_submitted,'기숙사 계약서'):''):'');
    return `<tr data-emp="${esc(e.id)}"><td class="c">${i+1}</td><td>${isTerminated(e)?settleBox(e,true):''}<b class="${isTerminated(e)&&e.exit_settled?'settled-name':''}">${esc(e.name)}</b>${isForeign(e)?` <span class="b bl">${esc(String(e.visa||'').trim()||'외국인')}</span>`:''}${isExitScheduled(e)?' <span class="b no">퇴사예정</span>':''}</td><td class="c">${esc(e.gender||'-')}${r.age!==null?' / '+r.age:''}</td><td>${esc(siteOf(e))}</td><td>${esc(deptLabel(e))||'<span class="muted">미지정</span>'}</td><td class="r">${e.hourly_wage?Number(e.hourly_wage).toLocaleString():'-'}</td><td>${esc(e.phone||'-')}</td><td>${esc(fmtDate(e.hire_date))}${isTerminated(e)?`<br><span class="exit-date-inline">퇴사 ${esc(fmtDate(e.termination_date))}</span>`:''}</td><td>${esc(tenureLabel(e.hire_date).replace(/^근속\s*/,''))}</td><td>${ctr}</td><td class="c">${String(e.account_no||'').trim()?`${esc(e.bank||'')} ✓`:'<span class="b no">미기재</span>'}</td><td class="c">${docs}</td><td class="note" title="${esc(e.notes||'')}">${esc(String(e.notes||'').split('\n')[0].replace(/^(비고|특이사항):\s*/,''))}</td></tr>`},(g,n,l)=>`<tr class="grp-row ${l}"><td colspan="13">${esc(g)} <span>${n}명</span></td></tr>`);
  const mob=withGroupHeads(a,(e,i)=>{const r=residentInfo(e.resident_no),c=currentContractInfo(e);
    return `<div class="mrow" data-emp="${esc(e.id)}"><div>${isTerminated(e)?settleBox(e,true):''}<b class="${isTerminated(e)&&e.exit_settled?'settled-name':''}">${i+1}. ${esc(e.name)}</b> <small>${esc(e.gender||'')}${r.age!==null?' '+r.age+'세':''} · ${esc(deptLabel(e)||'미지정')}${currentCompany==='전체'?' · '+esc(siteOf(e)):''}</small></div><div class="rt">${c.days===null?'':`<small>${c.seq?esc(c.seq)+'차':''}</small> <span class="b ${c.days<0?'no':c.days<=7?'wt':'gy'}">${c.days<0?'지남':c.days+'일'}</span>`}</div><div><small>입사 ${esc(fmtDate(e.hire_date))}${isTerminated(e)?` → <span class="exit-date-inline">퇴사 ${esc(fmtDate(e.termination_date))}</span>`:''} · ${esc(tenureLabel(e.hire_date).replace(/^근속\s*/,''))}${e.hourly_wage?' · '+Number(e.hourly_wage).toLocaleString()+'원':''}</small></div><div class="rt">${String(e.account_no||'').trim()?'':'<span class="b no">계좌 없음</span>'}</div></div>`},(g,n,l)=>`<div class="grp-head ${l}">${esc(g)} <span>${n}명</span></div>`);
  return {desk,mob};
}
function renderEmployeeList(a){
  const table=listView==='table';
  document.querySelectorAll('#viewToggle [data-view]').forEach(b=>b.classList.toggle('on',b.dataset.view===listView));
  if($('listSort'))$('listSort').value=listSort;
  show($('listSort'),currentTab!=='퇴사자');
  show($('employeeList'),!table);show($('rosterArea'),table);$('rosterArea').classList.toggle('one-company',currentCompany!=='전체');show($('rosterSum'),table&&showSum);show($('sumToggle'),table);$('sumToggle').textContent=showSum?'요약 숨기기 ▴':'요약 보기 ▾';
  if(!a.length){if(table){$('rosterBody').innerHTML='<tr><td colspan="13" class="dash-empty">표시할 직원이 없습니다.</td></tr>';$('rosterMobile').innerHTML='<div class="empty">표시할 직원이 없습니다.</div>';$('rosterSum').innerHTML=rosterSummary(a)}else $('employeeList').innerHTML='<div class="empty">표시할 직원이 없습니다.</div>';return}
  if(table){const r=rosterRows(a);$('rosterSum').innerHTML=rosterSummary(a);$('rosterBody').innerHTML=r.desk;$('rosterMobile').innerHTML=r.mob;return}
  $('employeeList').innerHTML=withGroupHeads(a,e=>cardHtml(e),(g,n,l)=>`<div class="grp-head ${l}">${esc(g)} <span>${n}명</span></div>`);
  document.querySelectorAll('.emp-card').forEach(x=>x.onclick=ev=>{if(ev.target.closest('.settle-check'))return;openEdit(x.dataset.id)});
}
function settleReady(){return !employees.length||Object.prototype.hasOwnProperty.call(employees[0],'exit_settled')}
function settleBox(e,small){if(!settleReady())return '';return `<label class="settle-check${small?' sm':''}" title="정산완료나면 체크"><input type="checkbox" data-settle="${esc(e.id)}" ${e.exit_settled?'checked':''}>${small?'':' 정산완료'}</label>`}
function fillExitMonths(){const sel=$('exitMonth');if(!sel)return;const show_=currentTab==='퇴사자';show(sel,show_);if(!show_)return;const cur=sel.value;const ms=[...new Set(employees.filter(isTerminated).filter(inCompany).map(e=>String(e.termination_date||'').slice(0,7)).filter(Boolean))].sort().reverse();sel.innerHTML='<option value="">퇴사 월: 전체</option>'+ms.map(m=>`<option value="${m}">${m.slice(0,4)}년 ${Number(m.slice(5))}월 (${employees.filter(isTerminated).filter(inCompany).filter(e=>String(e.termination_date||'').startsWith(m)).length}명)</option>`).join('');sel.value=ms.includes(cur)?cur:''}
async function toggleSettle(id,on){const {error}=await sb.from(EMP_TABLE).update({exit_settled:on}).eq('id',id);if(error){alert('저장 실패: '+error.message);render();return}const e=employees.find(x=>x.id===id);if(e)e.exit_settled=on;render()}
function initListView(){
  $('exitMonth').onchange=render;
  $('employeeSection').addEventListener('change',e=>{const c=e.target.closest('[data-settle]');if(c)toggleSettle(c.dataset.settle,c.checked)});
  $('viewToggle').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;listView=b.dataset.view;writePref('erp_list_view',listView);render()});
  $('listSort').onchange=e=>{listSort=e.target.value;writePref(sortPrefKey(),listSort);render()};
  $('sumToggle').onclick=()=>{showSum=!showSum;writePref('erp_list_sum',showSum?'1':'0');render()};
}
// ----- v003: 회사 전용 계정 (erp_user_access.allowed_site) -----
async function loadAccess(user){
  lockedSite=null;
  try{const {data,error}=await sb.from('erp_user_access').select('allowed_site').eq('user_id',user.id);if(!error&&data&&data[0]&&COMPANIES.includes(data[0].allowed_site))lockedSite=data[0].allowed_site}catch(e){}
  applyAccess();
}
function applyAccess(){
  document.body.classList.toggle('site-locked',!!lockedSite);
  if(!lockedSite)return;
  currentCompany=lockedSite;
  const keep=(sel,extra=[])=>{const el=$(sel);if(!el)return;[...el.options].forEach(o=>{if(o.value!==lockedSite&&!extra.includes(o.value))o.remove()});el.value=lockedSite};
  keep('companySelect');keep('site');keep('importSite');keep('calendarEventSite',['전체']);
  document.querySelectorAll('[data-company-card]').forEach(c=>show(c,c.dataset.companyCard===lockedSite));
  const p=document.querySelector('.erp-brand p');if(p)p.textContent=`${lockedSite} 전용 계정`;
  updateHeader();
}
// ----- v006: 연차현황 카드/표 전환 -----
let leaveView=readPref('erp_leave_view','card');
function renderLeaveTable(rows){
  document.querySelectorAll('#leaveViewToggle [data-view]').forEach(b=>b.classList.toggle('on',b.dataset.view===leaveView));
  if(leaveView!=='table')return;
  const list=rows.map(e=>({e,i:annualLeaveInfoForEmployee(e)}));
  if(!list.length){$('leaveHistoryList').innerHTML='<div class="empty">표시할 직원이 없습니다.</div>';return}
  const d=v=>esc(formatLeaveDays(Math.round(Number(v||0)*10)/10));
  const remCls=r=>r<0?'no':r<=1?'wt':'ok';
  const both=currentCompany==='전체';
  const desk=list.map(({e,i},n)=>`<tr data-emp="${esc(e.id)}"><td class="c">${n+1}</td><td><b>${esc(e.name)}</b></td>${both?`<td>${esc(siteOf(e))}</td>`:''}<td>${esc(e.department||'')||'<span class="muted">미지정</span>'}</td><td>${esc(fmtDate(e.hire_date))}</td><td class="period">${esc(i.periodStart||'-')} ~ ${esc(i.periodEnd||'-')}</td><td class="r">${d(i.granted)}${i.carryover>0?` <small class="muted">+이월 ${d(i.carryover)}</small>`:''}</td><td class="r">${d(i.used)}</td><td class="r"><span class="b ${remCls(i.remaining)}">${d(i.remaining)}</span></td></tr>`).join('');
  const mob=list.map(({e,i})=>`<div class="lrow" data-emp="${esc(e.id)}"><div class="ln"><b>${esc(e.name)}</b><small>${esc(deptLabel(e)||'미지정')}${both?' · '+esc(siteOf(e)):''}</small></div><div class="lv"><span><em>발생</em>${d(i.totalAvailable)}</span><span><em>사용</em>${d(i.used)}</span><span class="rem ${remCls(i.remaining)}"><em>잔여</em>${d(i.remaining)}</span></div></div>`).join('');
  $('leaveHistoryList').innerHTML=`<div class="roster leave-roster"><table><thead><tr><th>No.</th><th>성명</th>${both?'<th>소속</th>':''}<th>부서</th><th>입사일</th><th>현재 연차기간</th><th class="r">발생</th><th class="r">사용</th><th class="r">잔여</th></tr></thead><tbody>${desk}</tbody></table></div><div class="lmlist">${mob}</div>`;
}
function initLeaveView(){
  $('leaveViewToggle').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;leaveView=b.dataset.view;writePref('erp_leave_view',leaveView);renderAnnualLeaveHistory()});
}
function render(){updateHeader();if(currentTab==='달력'){renderCalendar();return}if(currentTab==='연차현황'){renderAnnualLeaveHistory();return}setCalendarMode(false);show($('annualLeaveHistoryView'),false);updateNavDocCount();if(currentTab==='대시보드'){renderDashboard();return}if(currentTab==='서류'){renderDocsView();return}if(currentTab==='부서'){renderDeptView();return}if(currentTab==='계정'){renderAccountsView();return}if(currentTab==='연동'){renderLinkView();return}if(currentTab==='피복'){renderUniformView();return}if(currentTab==='서명'){renderSignView();return}const active=employees.filter(e=>!isTerminated(e)); $('countActive').textContent=active.length; $('countSewon').textContent=active.filter(e=>siteOf(e)==='세원').length; $('countDaehan').textContent=active.filter(e=>siteOf(e)==='대한전선').length; $('countExpiring').textContent=active.filter(inCompany).filter(isExpiring).length; $('countExitScheduled').textContent=employees.filter(inCompany).filter(isExitScheduled).length; fillExitMonths();const a=filtered(); $('listTitle').innerHTML=`${esc(companyLabel())} · ${esc(listFilter?LIST_FILTER_LABEL[listFilter]:tabLabel())} · ${a.length}명${listFilter?' <button type="button" class="filter-chip" data-clear-filter>조건 풀기 ✕</button>':''}`; renderEmployeeList(sortList(a))}
function cardHtml(e){
  const mainPhoto=e.photo_url||'';
  const photo=mainPhoto
    ?`<img class="emp-photo" src="${esc(mainPhoto)}" onerror="this.outerHTML='<div class=\'emp-photo\'>사진 없음</div>'">`
    :'<div class="emp-photo">사진 없음</div>';

  const badges=currentCompany==='전체'?[`<span class="badge${siteOf(e)==='대한전선'?' site-daehan':''}">${esc(siteOf(e))}</span>`]:[];
  if(String(e.visa||'').trim())badges.push(`<span class="badge visa-badge">${esc(e.visa)}</span>`);

  const contractInfo=currentContractInfo(e);
  if(isExpiring(e)){
    const d=contractInfo.days;
    const label=d<0?`만료 ${Math.abs(d)}일 지남`:d===0?'오늘 만료':`만료 ${d}일 남음`;
    badges.push(`<span class="badge ${d<0?'expired':'warn'}">${label}</span>`);
  }
  if(isExitScheduled(e))badges.push(`<span class="badge exit-scheduled">퇴사 ${daysUntil(e.termination_date)}일 남음</span>`);
  if(isTerminated(e))badges.push('<span class="badge term">퇴사</span>');

  const contact=e.phone||e.address||'-';
  const wage=e.hourly_wage?` · 시급 ${Number(e.hourly_wage).toLocaleString()}원`:'';
  const detail=deptLabel(e)||(e.visa?`비자 ${e.visa}`:'-');
  const contractClass=contractInfo.days===null?'none':contractInfo.days<0?'overdue':contractInfo.days<=7?'soon':'normal';

  return `<article class="emp-card" data-id="${e.id}">
    ${photo}
    <div class="emp-info">
      <div>${badges.join('')}</div>
      <h3 class="${isTerminated(e)&&e.exit_settled?'settled-name':''}">${esc(e.name)}</h3>
      <p>${esc(detail)}${wage}</p>
      <p>${esc(contact)}</p>
      <p>입사 ${fmtDate(e.hire_date)}${isTerminated(e)?` → <b class="exit-date-inline">퇴사 ${fmtDate(e.termination_date)}</b>`:''}</p>
      ${isTerminated(e)?settleBox(e):''}
      ${isExitScheduled(e)?`<p class="exit-date">퇴사예정 ${fmtDate(e.termination_date)}</p>`:''}
    </div>
    <div class="emp-card-summary">
      <div class="summary-line tenure">${esc(tenureLabel(e.hire_date).replace(/^근속\s*/,''))}</div>
      <div class="summary-line contract ${contractClass}">${esc(contractCountdownLabel(e).replace(/\s*계약\s*/g,' ').replace(/\s+/g,' ').trim())}</div>
    </div>
  </article>`;
}

function isoParts(s){const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?{y:+m[1],m:+m[2],d:+m[3]}:null}
function isoFromUTCDate(d){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`}
function addDaysISO(s,n){const p=isoParts(s);if(!p)return '';const d=new Date(Date.UTC(p.y,p.m-1,p.d+n));return isoFromUTCDate(d)}
function addMonthsISO(s,n){const p=isoParts(s);if(!p)return '';const targetMonth=p.m-1+n;const first=new Date(Date.UTC(p.y,targetMonth,1));const lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();const d=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(p.d,lastDay)));return isoFromUTCDate(d)}
function addYearsISO(s,n){const p=isoParts(s);if(!p)return '';const y=p.y+n;const lastDay=new Date(Date.UTC(y,p.m,0)).getUTCDate();const d=new Date(Date.UTC(y,p.m-1,Math.min(p.d,lastDay)));return isoFromUTCDate(d)}
function buildStandardContractSchedule(hire,site=$('site')?.value){
  if(!isoParts(hire))return [];
  if(site==='대한전선'){
    // 대한전선: 1개월 → 1개월 → 1개월 → 9개월 (입사일 기준 총 1년)
    const ends=[addDaysISO(addMonthsISO(hire,1),-1),addDaysISO(addMonthsISO(hire,2),-1),addDaysISO(addMonthsISO(hire,3),-1),addDaysISO(addYearsISO(hire,1),-1)];
    const kinds=['1개월 계약','1개월 계약','1개월 계약','9개월 계약 (1년 채움)'];
    return ends.map((end,i)=>({sequence_no:i+1,contract_kind:kinds[i],contract_start_date:i?addDaysISO(ends[i-1],1):hire,contract_end_date:end,actual_write_date:null,memo:null}));
  }
  const s1=hire,e1=addDaysISO(s1,6);
  const s2=addDaysISO(e1,1),e2=addDaysISO(addMonthsISO(s2,1),-1);
  const s3=addDaysISO(e2,1),e3=addDaysISO(addMonthsISO(s3,1),-1);
  const s4=addDaysISO(e3,1),e4=addDaysISO(addMonthsISO(s4,1),-1);
  const s5=addDaysISO(e4,1);
  const e5=addDaysISO(addYearsISO(hire,1),-1);
  const rows=[
    [1,'1주 단기계약',s1,e1],
    [2,'1개월 계약',s2,e2],
    [3,'1개월 계약',s3,e3],
    [4,'1개월 계약',s4,e4],
    [5,'1년 채움 계약',s5,e5]
  ];
  return rows.map(([sequence_no,contract_kind,contract_start_date,contract_end_date])=>({sequence_no,contract_kind,contract_start_date,contract_end_date,actual_write_date:null,memo:null}));
}
let chFold=null; // v019: 차수별 펼침 상태 (null=새로 불러옴)
function renderContractHistory(){
  contractHistory.sort((a,b)=>(Number(a.sequence_no)||999)-(Number(b.sequence_no)||999));
  const box=$('contractHistoryList');
  if(!contractHistory.length){box.innerHTML='<div class="history-empty">저장된 근로계약서 이력이 없습니다.</div>';return}
  // v019: 지금 차수만 펼치고 나머지는 한 줄로 접기
  const tk=localDateKey(new Date());let cur=contractHistory.findIndex(r=>r.contract_start_date&&r.contract_start_date<=tk&&(!r.contract_end_date||r.contract_end_date>=tk));
  if(cur<0)cur=contractHistory.findIndex(r=>r.contract_end_date&&r.contract_end_date>=tk);if(cur<0)cur=contractHistory.length-1;
  const fresh=chFold===null;if(fresh)chFold=new Map();
  const isOpen=(r,i)=>{const k=String(r.sequence_no||i+1);if(!chFold.has(k))chFold.set(k,fresh?i===cur:true);return chFold.get(k)};
  box.innerHTML=contractHistory.map((r,i)=>`<div class="contract-history-row${isOpen(r,i)?'':' folded'}" data-contract-index="${i}" data-sequence-no="${esc(r.sequence_no||i+1)}">
    <button type="button" class="ch-sum"></button>
    <div class="contract-seq" title="접기"><strong>${esc(r.sequence_no||i+1)}차</strong><span>${esc(r.contract_kind||'추가 계약')}</span></div>
    <label>계약 시작<input class="ch-start" type="date" value="${esc(r.contract_start_date||'')}"></label>
    <label>계약 종료<input class="ch-end" type="date" value="${esc(r.contract_end_date||'')}"></label>
    <label>실제 작성일<input class="ch-actual" type="date" value="${esc(r.actual_write_date||'')}"></label>
    <label class="contract-complete"><input class="ch-complete" type="checkbox" ${r.actual_write_date?'checked':''}> 작성완료</label>
    <label class="contract-memo">메모<input class="ch-memo" value="${esc(r.memo||'')}"></label>
    <button type="button" class="contract-row-delete danger-outline">삭제</button>
  </div>`).join('');
  box.querySelectorAll('.contract-history-row').forEach(row=>{
    const complete=row.querySelector('.ch-complete'), actual=row.querySelector('.ch-actual');
    complete.addEventListener('change',()=>{if(complete.checked&&!actual.value)actual.value=row.querySelector('.ch-start').value||localDateKey(new Date());if(!complete.checked)actual.value=''});
    actual.addEventListener('change',()=>{complete.checked=!!actual.value});
    row.querySelector('.contract-row-delete').addEventListener('click',()=>{const i=Number(row.dataset.contractIndex);contractHistory.splice(i,1);renderContractHistory()});
    const sum=row.querySelector('.ch-sum'),k=String(row.dataset.sequenceNo);
    const fillSum=()=>{const st=row.querySelector('.ch-start').value,en=row.querySelector('.ch-end').value;sum.innerHTML=`<b>${esc(row.dataset.sequenceNo)}차</b><span>${st||en?esc(fmtDate(st)||'?')+' ~ '+esc(fmtDate(en)||'?'):'기간 없음'}</span><span class="b ${complete.checked?'ok':'no'}">${complete.checked?'작성완료':'미작성'}</span><i>›</i>`};
    fillSum();
    sum.addEventListener('click',()=>{row.classList.remove('folded');chFold.set(k,true)});
    row.querySelector('.contract-seq').addEventListener('click',()=>{fillSum();row.classList.add('folded');chFold.set(k,false)});
  });
}
function collectContractHistory(){
  const rows=[...$('contractHistoryList').querySelectorAll('.contract-history-row')];
  return rows.map((row,i)=>({
    sequence_no:Number(row.dataset.sequenceNo)||Number(contractHistory[i]?.sequence_no)||i+1,
    contract_kind:contractHistory[i]?.contract_kind||'추가 계약',
    contract_start_date:row.querySelector('.ch-start').value||null,
    contract_end_date:row.querySelector('.ch-end').value||null,
    actual_write_date:row.querySelector('.ch-actual').value||null,
    memo:row.querySelector('.ch-memo').value.trim()||null
  })).sort((a,b)=>a.sequence_no-b.sequence_no);
}
async function loadContractHistory(employeeId){
  chFold=null;
  if(!employeeId){contractHistory=[];renderContractHistory();return}
  const {data,error}=await sb.from(CONTRACT_TABLE).select('*').eq('employee_id',employeeId).order('sequence_no',{ascending:true});
  if(error){console.warn('근로계약서 이력 불러오기 실패',error);contractHistory=[]}else contractHistory=(data||[]).map(x=>({...x}));
  renderContractHistory();
}
async function saveContractHistory(employeeId){
  const rows=collectContractHistory();
  const {error:delErr}=await sb.from(CONTRACT_TABLE).delete().eq('employee_id',employeeId);
  if(delErr)throw delErr;
  if(!rows.length)return;
  const payload=rows.map(r=>({...r,employee_id:employeeId,status:r.actual_write_date?'작성완료':'예정',updated_at:new Date().toISOString()}));
  const {error}=await sb.from(CONTRACT_TABLE).insert(payload);
  if(error)throw error;
}
function contractSummaryDates(rows){
  const valid=(rows||[]).filter(r=>r.contract_start_date||r.contract_end_date);
  if(!valid.length)return {start:null,end:null};
  const starts=valid.map(r=>r.contract_start_date).filter(Boolean).sort();
  const ends=valid.map(r=>r.contract_end_date).filter(Boolean).sort();
  return {start:starts[0]||null,end:ends.at(-1)||null};
}
function closeContractStageModal(){show($('contractStageModal'),false)}
function openContractStageModal(){
  const hire=$('hireDate').value;
  if(!hire){alert('입사일을 먼저 입력해주세요.');return}
  const rows=buildStandardContractSchedule(hire);
  renderContractStageButtons(rows.length);
  $('contractStagePreview').innerHTML=rows.map(r=>`<div><strong>${r.sequence_no}차</strong><span>${esc(r.contract_start_date)} ~ ${esc(r.contract_end_date)}</span></div>`).join('');
  show($('contractStageModal'));
}
function applyContractStage(stage){
  const hire=$('hireDate').value;
  if(!hire){closeContractStageModal();alert('입사일을 먼저 입력해주세요.');return}
  const standard=buildStandardContractSchedule(hire);
  const current=collectContractHistory();
  const keepDetails=(fresh,old)=>old?{...fresh,actual_write_date:old.actual_write_date||null,memo:old.memo||null}:{...fresh};
  if(stage==='all'){
    contractHistory=standard.map(fresh=>keepDetails(fresh,current.find(x=>Number(x.sequence_no)===Number(fresh.sequence_no))));
  }else{
    const seq=Number(stage);
    const fresh=standard.find(x=>x.sequence_no===seq);
    if(!fresh)return;
    const old=current.find(x=>Number(x.sequence_no)===seq);
    const merged=keepDetails(fresh,old);
    contractHistory=current.filter(x=>Number(x.sequence_no)!==seq);
    contractHistory.push(merged);
    contractHistory.sort((a,b)=>Number(a.sequence_no)-Number(b.sequence_no));
  }
  closeContractStageModal();
  renderContractHistory();
}
function autoGenerateContracts(){openContractStageModal()}
function addContractHistoryRow(){
  contractHistory=collectContractHistory();
  const next=Math.max(contractStageCount(),...contractHistory.map(x=>Number(x.sequence_no)||0))+1;
  contractHistory.push({sequence_no:next,contract_kind:'추가 계약',contract_start_date:'',contract_end_date:'',actual_write_date:null,memo:null});
  renderContractHistory();
}

function resetEmployeeModalScroll(){
  const run=()=>{
    const modal=$('modal');
    const card=modal?.querySelector('.modal-card');
    const form=$('employeeForm');
    try{document.activeElement?.blur?.()}catch(e){}
    if(card){card.scrollTop=0;card.scrollLeft=0;if(card.scrollTo)card.scrollTo(0,0)}
    if(form){form.scrollTop=0;form.scrollLeft=0}
    if(modal){modal.scrollTop=0;modal.scrollLeft=0}
  };
  run();
  requestAnimationFrame(run);
  setTimeout(run,40);
  setTimeout(run,120);
}


let imageViewerUrl='';
let imageViewerName='사진.jpg';

function openImageViewerFromPreview(previewId,title,filename){
  const preview=$(previewId);
  const img=preview?.querySelector('img');
  if(!img || !img.src)return;
  imageViewerUrl=img.src;
  imageViewerName=filename||'사진.jpg';
  $('imageViewerTitle').textContent=title||'사진 보기';
  $('imageViewerImg').src=imageViewerUrl;
  $('imageViewer').classList.remove('hidden');
  $('imageViewer').setAttribute('aria-hidden','false');
}

function closeImageViewer(){
  $('imageViewer').classList.add('hidden');
  $('imageViewer').setAttribute('aria-hidden','true');
  $('imageViewerImg').removeAttribute('src');
  imageViewerUrl='';
}

async function saveViewedImage(){
  if(!imageViewerUrl)return;
  try{
    const res=await fetch(imageViewerUrl,{cache:'no-store'});
    if(!res.ok)throw new Error('이미지를 불러올 수 없습니다.');
    const blob=await res.blob();
    const objectUrl=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=objectUrl;
    a.download=imageViewerName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),1500);
  }catch(e){
    // 일부 휴대폰 브라우저에서 외부 이미지 다운로드가 막히면 새 창으로 열어 저장 가능하게 처리
    const a=document.createElement('a');
    a.href=imageViewerUrl;
    a.target='_blank';
    a.rel='noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    alert('사진이 새 화면으로 열렸습니다. 휴대폰에서는 사진을 길게 눌러 저장할 수 있습니다.');
  }
}

function openNew(){currentEmployee=null;contractHistory=[];chFold=null;$('modalTitle').textContent='직원 등록';$('employeeForm').reset();$('photoFile').value='';$('photoCameraFile').value='';$('idDocFile').value='';$('idDocCameraFile').value='';$('site').value=currentCompany!=='전체'?currentCompany:'세원';updateContractRuleHelp();setDocFields(null);document.querySelector('input[name="taxType"][value=""]').checked=true;setNationality('local');updateHandoverVisibility();$('empId').value='';$('photoPreview').textContent='사진 없음';$('idDocPreview').textContent='등록 없음';show($('photoDeleteBtn'),false);show($('idDocDeleteBtn'),false);show($('terminateBtn'),false);show($('restoreBtn'),false);show($('deleteBtn'),false);renderContractHistory();refreshAnnualLeaveSummary();show($('modal'));resetEmployeeModalScroll();requestAnimationFrame(()=>{resizeMemoFields();resetEmployeeModalScroll()})}
async function openEdit(id){currentEmployee=employees.find(e=>e.id===id);if(!currentEmployee)return;$('photoFile').value='';$('photoCameraFile').value='';$('idDocFile').value='';$('idDocCameraFile').value='';$('modalTitle').textContent='직원 상세 / 수정';$('empId').value=currentEmployee.id; for(const [db,dom] of Object.entries(fields))$(dom).value=currentEmployee[db]??''; if(!$('site').value)$('site').value='세원'; updateContractRuleHelp(); setDocFields(currentEmployee); updateHandoverVisibility(); const tax=document.querySelector(`input[name="taxType"][value="${CSS.escape(currentEmployee.tax_type||'')}"]`)||document.querySelector('input[name="taxType"][value=""]');if(tax)tax.checked=true;setNationality(currentEmployee.visa?'foreign':'local'); if(currentEmployee.photo_url)$('photoPreview').innerHTML=`<img src="${esc(currentEmployee.photo_url)}">`;else $('photoPreview').textContent='사진 없음';show($('photoDeleteBtn'),!!currentEmployee.photo_url);if(currentEmployee.id_document_url)$('idDocPreview').innerHTML=`<img src="${esc(currentEmployee.id_document_url)}">`;else $('idDocPreview').textContent='등록 없음';show($('idDocDeleteBtn'),!!currentEmployee.id_document_url);await loadContractHistory(currentEmployee.id);refreshAnnualLeaveSummary();const term=isTerminated(currentEmployee);show($('terminateBtn'),!term);show($('restoreBtn'),term);show($('deleteBtn'),term);show($('modal'));resetEmployeeModalScroll();requestAnimationFrame(()=>{resizeMemoFields();resetEmployeeModalScroll()})}
function closeModal(){resetEmployeeModalScroll();$('photoFile').value='';$('photoCameraFile').value='';$('idDocFile').value='';$('idDocCameraFile').value='';show($('modal'),false);currentEmployee=null;contractHistory=[]}
function photoPathFromUrl(url){if(!url)return null;try{const u=new URL(url);const marker=`/storage/v1/object/public/${PHOTO_BUCKET}/`;const i=u.pathname.indexOf(marker);return i>=0?decodeURIComponent(u.pathname.slice(i+marker.length)):null}catch{return null}}
async function removeStoredPhoto(url){const path=photoPathFromUrl(url);if(!path)return;const {error}=await sb.storage.from(PHOTO_BUCKET).remove([path]);if(error)throw error}
async function deletePhoto(){
  if(!currentEmployee?.photo_url)return;
  if(!confirm(`${currentEmployee.name} 직원의 사진을 삭제할까요?`))return;
  const oldUrl=currentEmployee.photo_url;
  try{
    const {error}=await sb.from(EMP_TABLE).update({photo_url:null}).eq('id',currentEmployee.id);
    if(error)throw error;
    currentEmployee.photo_url=null;
    try{await removeStoredPhoto(oldUrl)}catch(e){console.warn('Storage 기존 사진 삭제 실패',e)}
    $('photoFile').value='';$('photoCameraFile').value='';
    $('photoPreview').textContent='사진 없음';
    show($('photoDeleteBtn'),false);
    await loadEmployees();
    alert('사진을 삭제했습니다.');
  }catch(e){alert('사진 삭제 실패: '+e.message)}
}
function uploadPhoto(file,id){if(!file)return Promise.resolve(null);return (async()=>{const ext=(file.name.split('.').pop()||'jpg').toLowerCase();const path=`${id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;const {error}=await sb.storage.from(PHOTO_BUCKET).upload(path,file,{upsert:false,cacheControl:'0'});if(error)throw error;const {data}=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);return data.publicUrl})()}
async function deleteIdDocument(){
  if(!currentEmployee?.id_document_url)return;
  if(!confirm(`${currentEmployee.name} 직원의 신분증/여권 이미지를 삭제할까요?`))return;
  const oldUrl=currentEmployee.id_document_url;
  try{
    const {error}=await sb.from(EMP_TABLE).update({id_document_url:null}).eq('id',currentEmployee.id);
    if(error)throw error;
    currentEmployee.id_document_url=null;
    try{await removeStoredPhoto(oldUrl)}catch(e){console.warn('Storage 기존 신분증/여권 삭제 실패',e)}
    $('idDocFile').value='';$('idDocCameraFile').value='';
    $('idDocPreview').textContent='등록 없음';
    show($('idDocDeleteBtn'),false);
    await loadEmployees();
    alert('신분증/여권 이미지를 삭제했습니다.');
  }catch(e){alert('신분증/여권 삭제 실패: '+e.message)}
}
function uploadIdDocument(file,id){
  if(!file)return Promise.resolve(null);
  return (async()=>{
    const ext=(file.name.split('.').pop()||'jpg').toLowerCase();
    const path=`id-documents/${id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const {error}=await sb.storage.from(PHOTO_BUCKET).upload(path,file,{upsert:false,cacheControl:'0'});
    if(error)throw error;
    const {data}=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);
    return data.publicUrl
  })()
}
async function saveEmployee(ev){
  ev.preventDefault();
  try{
    const isUpdate=!!$('empId').value;
    const id=$('empId').value||crypto.randomUUID();
    const obj={};
    for(const [db,dom] of Object.entries(fields)){
      const el=$(dom);
      obj[db]=el.type==='number'?(el.value?Number(el.value):null):(el.value.trim()||null);
    }
    if(obj.hire_date&&obj.hire_date>='2025-08-01')obj.handover_date=null;
    const leaveBase=annualLeaveBaseForEmployee({hire_date:obj.hire_date});
    if(Number(leaveBase.serviceYears||0)<1){
      obj.annual_leave_unused_days=0;
      obj.annual_leave_carryover_days=0;
    }else{
      const carry=Number(obj.annual_leave_carryover_days||0);
      if(!Number.isFinite(carry)||carry<0||carry>80){alert('이월 연차일수를 확인해주세요.');$('annualLeaveCarryoverInput').focus();return}
      obj.annual_leave_unused_days=0;
      obj.annual_leave_carryover_days=Math.round(carry*10)/10;
    }
    const leaveInputRaw=$('annualLeaveGrantedInput').value;
    const leaveInput=leaveInputRaw===''?leaveBase.autoGranted:Number(leaveInputRaw);
    if(!Number.isFinite(leaveInput)||leaveInput<0){alert('발생 연차일수를 확인해주세요.');$('annualLeaveGrantedInput').focus();return}
    if(leaveBase.periodStart&&Math.abs(leaveInput-leaveBase.autoGranted)>0.001){
      obj.annual_leave_granted_override=Math.round(leaveInput*10)/10;
      obj.annual_leave_override_period_start=leaveBase.periodStart;
    }else{
      obj.annual_leave_granted_override=null;
      obj.annual_leave_override_period_start=null;
    }
    const foreign=$('nationalityForeign').checked;
    if(foreign&&!obj.visa){alert('외국인은 비자를 입력해주세요.');$('visa').focus();return}
    if(!foreign)obj.visa=null;
    obj.tax_type=document.querySelector('input[name="taxType"]:checked')?.value||null;
    if(docV8Ready()){obj.uses_dorm=$('usesDorm').checked;obj.doc_dorm_submitted=$('usesDorm').checked&&$('docDorm').checked}
    const historyRows=collectContractHistory();
    const summary=contractSummaryDates(historyRows);
    obj.contract_start_date=summary.start;
    obj.contract_end_date=summary.end;
    obj.employment_status=(obj.termination_date&&daysUntil(obj.termination_date)<=0)?'퇴사':'재직';

    const photoFile=$('photoCameraFile').files[0]||$('photoFile').files[0]||null;
    const idDocFile=$('idDocCameraFile').files[0]||$('idDocFile').files[0]||null;
    const oldPhoto=currentEmployee?.photo_url||null;
    const oldIdDoc=currentEmployee?.id_document_url||null;
    let newPhoto=null;
    let newIdDoc=null;

    // 핵심: 새 사진을 직접 선택/촬영한 경우에만 사진 URL을 변경한다.
    if(photoFile){newPhoto=await uploadPhoto(photoFile,id);obj.photo_url=newPhoto}
    else if(!isUpdate){obj.photo_url=null}

    if(idDocFile){newIdDoc=await uploadIdDocument(idDocFile,id);obj.id_document_url=newIdDoc}
    else if(!isUpdate){obj.id_document_url=null}

    if(isUpdate){
      const {error}=await sb.from(EMP_TABLE).update(obj).eq('id',id);
      if(error)throw error;
    }else{
      obj.id=id;
      const {data:{user}}=await sb.auth.getUser();
      obj.created_by=user?.id||null;
      const {error}=await sb.from(EMP_TABLE).insert(obj);
      if(error)throw error;
    }

    // DB가 새 URL로 정상 저장된 뒤에만 기존 파일을 삭제
    if(newPhoto&&oldPhoto&&oldPhoto!==newPhoto){try{await removeStoredPhoto(oldPhoto)}catch(e){console.warn('기존 사진 삭제 실패',e)}}
    if(newIdDoc&&oldIdDoc&&oldIdDoc!==newIdDoc){try{await removeStoredPhoto(oldIdDoc)}catch(e){console.warn('기존 신분증/여권 삭제 실패',e)}}

    contractHistory=historyRows;
    await saveContractHistory(id);
    closeModal();
    await loadEmployees();
  }catch(e){alert('저장 실패: '+e.message)}
}
async function terminate(){if(!currentEmployee)return;const d=prompt('퇴사일을 입력하세요 (YYYY-MM-DD)',new Date().toISOString().slice(0,10));if(!d)return;if(!confirm(`${currentEmployee.name} 직원을 퇴사 처리할까요?`))return; const status=daysUntil(d)>0?'재직':'퇴사'; const {error}=await sb.from(EMP_TABLE).update({employment_status:status,termination_date:d}).eq('id',currentEmployee.id);if(error)return alert(error.message);closeModal();await loadEmployees()}
async function restore(){if(!currentEmployee||!confirm(`${currentEmployee.name} 직원을 재직자로 복구할까요?`))return;const {error}=await sb.from(EMP_TABLE).update({employment_status:'재직',termination_date:null}).eq('id',currentEmployee.id);if(error)return alert(error.message);closeModal();await loadEmployees()}
async function permanentDelete(){if(!currentEmployee)return;if(!confirm(`${currentEmployee.name} 직원 정보를 영구삭제합니다. 되돌릴 수 없습니다.`))return;if(!confirm('정말 영구삭제할까요?'))return;(async()=>{try{if(currentEmployee.photo_url){try{await removeStoredPhoto(currentEmployee.photo_url)}catch(e){console.warn('사진 삭제 실패',e)}}if(currentEmployee.id_document_url){try{await removeStoredPhoto(currentEmployee.id_document_url)}catch(e){console.warn('신분증/여권 삭제 실패',e)}}const {error}=await sb.from(EMP_TABLE).delete().eq('id',currentEmployee.id);if(error)throw error;closeModal();await loadEmployees()}catch(e){alert('영구삭제 실패: '+e.message)}})()}
async function imageToExcelData(url){
  if(!url)return null;
  try{
    const res=await fetch(url,{cache:'no-store'});
    if(!res.ok)throw new Error('사진 불러오기 실패');
    const blob=await res.blob();
    let useBlob=blob;
    let extension='jpeg';
    const type=(blob.type||'').toLowerCase();
    if(type.includes('png')) extension='png';
    else if(type.includes('jpeg')||type.includes('jpg')) extension='jpeg';
    else{
      // ExcelJS가 지원하지 않는 WEBP 등은 PNG로 변환
      const bmp=await createImageBitmap(blob);
      const canvas=document.createElement('canvas');
      canvas.width=bmp.width;canvas.height=bmp.height;
      canvas.getContext('2d').drawImage(bmp,0,0);
      useBlob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png',0.92));
      extension='png';
      if(bmp.close)bmp.close();
    }
    const base64=await new Promise((resolve,reject)=>{
      const fr=new FileReader();
      fr.onload=()=>resolve(fr.result);
      fr.onerror=()=>reject(fr.error||new Error('사진 변환 실패'));
      fr.readAsDataURL(useBlob);
    });
    return {base64,extension};
  }catch(e){
    console.warn('엑셀 사진 삽입 실패',url,e);
    return null;
  }
}

function safeExcelSheetName(name){
  return String(name||'평택 인력관리').replace(/[\/?*\[\]:]/g,'_').slice(0,31)||'평택 인력관리';
}

async function exportExcel(){
  const btn=$('exportBtn');
  const oldText=btn.textContent;
  try{
    if(!window.ExcelJS)throw new Error('엑셀 기능을 불러오지 못했습니다. 인터넷 연결 후 다시 시도해주세요.');
    const list=filtered();
    if(!list.length){alert('내보낼 직원이 없습니다.');return}
    btn.disabled=true;btn.textContent='엑셀 만드는 중...';

    const workbook=new ExcelJS.Workbook();
    workbook.creator='가나안ERP';
    workbook.created=new Date();
    const ws=workbook.addWorksheet(safeExcelSheetName(`${companyLabel()} ${tabLabel()}`));
    ws.views=[{state:'frozen',ySplit:1}];

    const headers=[
      ['직원사진',null,16],['신분증/여권',null,18],
      ['소속','site',12],['성명','name',14],['성별','gender',8],['내/외국인','nationality_display',11],['부서','department',18],['시급','hourly_wage',12],['비자','visa',12],
      ['주민번호','resident_no',18],['전화번호','phone',16],['주소','address',36],
      ['면접경로','interview_route',18],['락커룸','locker_room',16],['4대보험/3.3%','tax_type',14],
      ['근무이력','work_history',34],['입사일','hire_date',13],['인계일','handover_date',13],
      ['연차 정산일','annual_leave_settlement_date',14],['연차 자동발생','annual_leave_auto_granted',12],['연차 발생(적용)','annual_leave_granted',13],['이월연차','annual_leave_carryover_days',11],['연차 총보유','annual_leave_total_available',11],['연차 사용','annual_leave_used',11],['연차 잔여','annual_leave_remaining',11],['연차수당','annual_leave_allowance',15],
      ['퇴직금정산일','severance_settlement_date',16],['퇴사일','termination_date',13],
      ['은행','bank',12],['계좌번호','account_no',20],['예금주','account_holder',12],
      ['현재 계약','contract_now',16],['근로계약서','doc_contract_display',11],['신분증','doc_id_display',9],['통장사본','doc_bank_display',9],['기숙사','dorm_display',8],['기숙사 계약서','doc_dorm_display',12],
      ['특이사항','notes',32],['재직상태','employment_status',12]
    ];

    ws.columns=headers.map(h=>({header:h[0],key:h[1]||undefined,width:h[2]}));
    ws.getRow(1).height=25;
    ws.getRow(1).eachCell(cell=>{
      cell.font={bold:true,name:'맑은 고딕'};
      cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE2E8F0'}};
      cell.border={top:{style:'thin',color:{argb:'FFCBD5E1'}},bottom:{style:'thin',color:{argb:'FFCBD5E1'}},left:{style:'thin',color:{argb:'FFCBD5E1'}},right:{style:'thin',color:{argb:'FFCBD5E1'}}};
    });

    for(let i=0;i<list.length;i++){
      const e=list[i];
      const leaveInfo=annualLeaveInfoForEmployee(e);
      const values=headers.map((h,idx)=>{
        if(idx<2)return '';
        if(h[1]==='nationality_display')return nationalityLabel(e);
        if(h[1]==='contract_now'){const c=currentContractInfo(e);return c.end?`${c.seq?c.seq+'차 ':''}~${c.end}`:''}
        if(h[1]==='doc_contract_display')return contractDocStatus(e).label;
        if(h[1]==='doc_id_display')return idDocOk(e)?'O':'X';
        if(h[1]==='doc_bank_display')return bankKind(e)||'X';
        if(h[1]==='dorm_display')return e.uses_dorm?'사용':'';
        if(h[1]==='doc_dorm_display')return e.uses_dorm?(e.doc_dorm_submitted?'O':'X'):'';
        if(h[1]==='annual_leave_auto_granted')return leaveInfo.autoGranted;
        if(h[1]==='annual_leave_granted')return leaveInfo.granted;
        if(h[1]==='annual_leave_carryover_days')return leaveInfo.carryover;
        if(h[1]==='annual_leave_total_available')return leaveInfo.totalAvailable;
        if(h[1]==='annual_leave_used')return leaveInfo.used;
        if(h[1]==='annual_leave_remaining')return leaveInfo.remaining;
        if(h[1]==='annual_leave_allowance')return leaveInfo.allowance.missingYears.length?'최저시급 미등록':leaveInfo.allowance.amount;
        return e[h[1]]??'';
      });
      const row=ws.addRow(values);
      row.height=86;
      row.eachCell({includeEmpty:true},cell=>{
        cell.font={name:'맑은 고딕',size:10};
        cell.alignment={vertical:'middle',wrapText:true};
        cell.border={top:{style:'thin',color:{argb:'FFE5E7EB'}},bottom:{style:'thin',color:{argb:'FFE5E7EB'}},left:{style:'thin',color:{argb:'FFE5E7EB'}},right:{style:'thin',color:{argb:'FFE5E7EB'}}};
      });

      const [photo,idDoc]=await Promise.all([
        imageToExcelData(e.photo_url),
        imageToExcelData(e.id_document_url)
      ]);
      const excelRow=row.number-1;
      if(photo){
        const imageId=workbook.addImage(photo);
        ws.addImage(imageId,{tl:{col:0.12,row:excelRow+0.08},ext:{width:78,height:78}});
      }else if(e.photo_url){
        row.getCell(1).value={text:'사진 열기',hyperlink:e.photo_url};
        row.getCell(1).font={name:'맑은 고딕',size:9,underline:true};
      }
      if(idDoc){
        const imageId=workbook.addImage(idDoc);
        ws.addImage(imageId,{tl:{col:1.12,row:excelRow+0.08},ext:{width:94,height:78}});
      }else if(e.id_document_url){
        row.getCell(2).value={text:'사진 열기',hyperlink:e.id_document_url};
        row.getCell(2).font={name:'맑은 고딕',size:9,underline:true};
      }
      btn.textContent=`엑셀 만드는 중... ${i+1}/${list.length}`;
      if(i%8===7)await new Promise(r=>setTimeout(r,0));
    }

    ws.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};

    const employeeIds=list.map(x=>x.id);
    if(employeeIds.length){
      const {data:hist,error:histErr}=await sb.from(CONTRACT_TABLE).select('*').in('employee_id',employeeIds).order('employee_id').order('sequence_no');
      if(!histErr&&hist?.length){
        const nameMap=new Map(list.map(x=>[x.id,x]));
        const hs=workbook.addWorksheet('근로계약서이력');
        hs.columns=[
          {header:'성명',key:'name',width:14},{header:'소속',key:'site',width:10},{header:'차수',key:'seq',width:8},{header:'구분',key:'kind',width:16},
          {header:'계약 시작일',key:'start',width:14},{header:'계약 종료일',key:'end',width:14},{header:'실제 작성일',key:'actual',width:14},
          {header:'상태',key:'status',width:12},{header:'메모',key:'memo',width:30}
        ];
        hs.getRow(1).font={bold:true,name:'맑은 고딕'};
        hist.forEach(h=>{const e=nameMap.get(h.employee_id)||{};hs.addRow({name:e.name||'',site:e.site||'',seq:h.sequence_no,kind:h.contract_kind||'',start:h.contract_start_date||'',end:h.contract_end_date||'',actual:h.actual_write_date||'',status:h.status||'',memo:h.memo||''})});
        hs.eachRow((row,n)=>{row.alignment={vertical:'middle',wrapText:true};row.font={name:'맑은 고딕',size:n===1?10:9}});
        hs.autoFilter={from:{row:1,column:1},to:{row:1,column:9}};
      }
    }

    const buffer=await workbook.xlsx.writeBuffer();
    const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`가나안ERP_${companyLabel()}_${tabLabel()}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }catch(e){
    alert('엑셀 내보내기 실패: '+e.message);
  }finally{
    btn.disabled=false;btn.textContent=oldText;
  }
}
async function init(){if(!sb){$('loginError').textContent='config.js의 Supabase 설정을 확인하세요.';return}const {data:{session}}=await sb.auth.getSession();if(session)enter(session.user); sb.auth.onAuthStateChange((_e,s)=>{if(s)enter(s.user);else{show($('loginView'));show($('appView'),false)}})}
async function enter(user){show($('loginView'),false);show($('appView'));$('userEmail').textContent='';await loadMyAccount(user);await loadAccess(user);try{await loadEmployees()}catch(e){alert('데이터를 불러오지 못했습니다: '+e.message)}await Promise.all([loadCalendarEvents(true),loadBirthdayChecks(true)]);subscribeCalendar();if(currentTab==='달력')renderCalendar();else render()}
// ----- v007: 이름 + 숫자 4자리 로그인 (Cloudflare Worker /api 를 거쳐 로그인) -----
async function api(path,body,method){const h={'content-type':'application/json'};const {data:{session}}=await sb.auth.getSession();if(session)h.authorization='Bearer '+session.access_token;const r=await fetch(path,{method:method||(body?'POST':'GET'),headers:h,body:body?JSON.stringify(body):undefined,cache:'no-store'});let d=null;try{d=await r.json()}catch{}if(!r.ok)throw new Error(d?.message||('서버 응답 오류 ('+r.status+')'));return d}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;try{const d=await api('/api/login',{name:$('loginName').value,pin:$('loginPin').value});const {error}=await sb.auth.setSession({access_token:d.access_token,refresh_token:d.refresh_token});if(error)throw error;$('loginPin').value=''}catch(err){$('loginError').textContent=err.message;$('loginPin').value='';$('loginPin').focus()}finally{btn.disabled=false}});
(async()=>{try{const st=await api('/api/status');if(st.needs_setup)show($('setupBtn'))}catch(e){}})();
$('setupBtn').onclick=async()=>{const code=prompt('설치 암호(Cloudflare에 넣은 SETUP_CODE)를 입력하세요.');if(!code)return;const name=prompt('첫 관리자 이름');if(!name)return;const pin=prompt('비밀번호 숫자 4자리');if(!/^\d{4}$/.test(pin||''))return alert('숫자 4자리로 입력해주세요.');try{await api('/api/setup',{setup_code:code,name,pin});alert('관리자 계정을 만들었습니다. 이제 로그인하세요.');show($('setupBtn'),false);$('loginName').value=name.trim();$('loginPin').focus()}catch(err){alert(err.message)}};
let myAccount=null;
// v027: 화면 이름만 바꿈 (DB 값은 그대로) 관리자=admin(맨 위, 계정 관리 가능), 사용자=manager(계정 관리 안 보임)
const TOP_NAME='가나안'; // v028: 이 이름의 admin 계정은 '총괄'로 표시
function roleLabel(r,name){return r==='관리자'&&String(name||'').trim()===TOP_NAME?'총괄':r==='관리자'?'admin':r==='사용자'?'manager':String(r||'')}
async function loadMyAccount(user){myAccount=null;try{const {data}=await sb.from('erp_accounts').select('name,role').eq('id',user.id).maybeSingle();myAccount=data||null}catch(e){}
  $('userEmail').textContent=myAccount?`${myAccount.name}${' ('+roleLabel(myAccount.role,myAccount.name)+')'}`:(user.email||'');
  document.querySelectorAll('.admin-only').forEach(el=>show(el,myAccount?.role==='관리자'));
  if((currentTab==='계정'||currentTab==='연동')&&myAccount?.role!=='관리자')currentTab='대시보드';
  if(myAccount?.role==='관리자')refreshLinkCount();}
let accountsCache=[];
function fmtDT(v){if(!v)return '-';const d=new Date(v);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function accountMsg(t,isErr){const el=$('accountMsg');el.textContent=t;el.style.color=isErr?'#b91c1c':'';show(el,!!t)}
async function renderAccountsView(){
  if(currentTab!=='계정')return;
  showErpView('accountsView');show($('addBtn'),false);
  if(myAccount?.role!=='관리자'){$('accountsTable').innerHTML='<tr><td colspan="6">admin만 볼 수 있습니다.</td></tr>';return}
  try{accountsCache=await api('/api/accounts')}catch(e){$('accountsTable').innerHTML=`<tr><td colspan="6">${esc(e.message)}</td></tr>`;return}
  const now=Date.now();
  $('accountsTable').innerHTML=accountsCache.map(a=>{const locked=a.locked_until&&Date.parse(a.locked_until)>now;
    const st=!a.active?'<span class="b no">사용 중지</span>':locked?'<span class="b lock">잠김</span>':'<span class="b ok">사용</span>';
    return `<tr><td><b>${esc(a.name)}</b>${a.me?' <small>(나)</small>':''}</td><td><span class="b ${a.role==='관리자'?'bl':'gy'}">${roleLabel(a.role,a.name)}</span></td><td>${esc(a.site?a.site+'만':'전체')}</td><td>${st}</td><td>${esc(fmtDT(a.last_login_at))}</td>
    <td><div class="acc-actions"><button type="button" class="ghost" data-acc-pin="${esc(a.id)}">비밀번호 초기화</button><button type="button" class="ghost" data-acc-site="${esc(a.id)}">회사</button><button type="button" class="ghost" data-acc-role="${esc(a.id)}">권한</button>${a.me?'':`<button type="button" class="${a.active?'danger-outline':'success'}" data-acc-active="${esc(a.id)}">${a.active?'사용 중지':'다시 사용'}</button>`}</div></td></tr>`}).join('')||'<tr><td colspan="6">계정이 없습니다.</td></tr>';
  renderPhotoMove();
}
$('accountForm').onsubmit=async e=>{e.preventDefault();const pin=$('accPin').value;if(!/^\d{4}$/.test(pin))return accountMsg('비밀번호는 숫자 4자리입니다.',true);
  try{const a=await api('/api/accounts',{name:$('accName').value,pin,role:$('accRole').value,site:$('accSite').value||null});accountMsg(`'${a.name}' 계정을 만들었습니다. 이름과 숫자 4자리를 본인에게 알려주세요.`);e.target.reset();renderAccountsView()}catch(err){accountMsg(err.message,true)}};
$('accountsTable').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.accPin||b.dataset.accSite||b.dataset.accRole||b.dataset.accActive;const a=accountsCache.find(x=>x.id===id);if(!a)return;
  try{
    if(b.dataset.accPin){const pin=prompt(`${a.name} 의 새 비밀번호 (숫자 4자리)`);if(pin===null)return;if(!/^\d{4}$/.test(pin))return alert('숫자 4자리로 입력해주세요.');await api('/api/accounts/pin',{id,pin});accountMsg(`${a.name} 비밀번호를 바꿨습니다. 잠김도 풀렸습니다.`)}
    else if(b.dataset.accSite){const v=prompt(`${a.name} 이(가) 볼 수 있는 회사\n전체 / 세원 / 대한전선 중 하나를 입력하세요.`,a.site||'전체');if(v===null)return;const site=v.trim()==='전체'||!v.trim()?null:v.trim();if(site&&!COMPANIES.includes(site))return alert('전체, 세원, 대한전선 중 하나로 입력해주세요.');await api('/api/accounts/site',{id,site});accountMsg(`${a.name}: ${site?site+'만':'전체'} 보기로 바꿨습니다. 다음 로그인부터 적용됩니다.`)}
    else if(b.dataset.accRole){const role=a.role==='관리자'?'사용자':'관리자';if(!confirm(`${a.name} 을(를) '${roleLabel(role)}'(으)로 바꿀까요?`))return;await api('/api/accounts/role',{id,role});accountMsg(`${a.name}: ${roleLabel(role)}`)}
    else if(b.dataset.accActive){const active=!a.active;if(!confirm(`${a.name} 계정을 ${active?'다시 사용':'사용 중지'}할까요?`))return;await api('/api/accounts/active',{id,active});accountMsg(`${a.name}: ${active?'다시 사용':'사용 중지'}`)}
    renderAccountsView();
  }catch(err){accountMsg(err.message,true)}};
// 기존 DB(osmeoigypxzlfftcufcu)에 남아 있는 직원 사진·신분증을 새 DB로 옮기기 (관리자 화면)
const OLD_PHOTO_HOST='osmeoigypxzlfftcufcu.supabase.co';
function oldPhotoTargets(){const out=[];employees.forEach(e=>['photo_url','id_document_url'].forEach(f=>{if(e[f]&&String(e[f]).includes(OLD_PHOTO_HOST))out.push({e,f})}));return out}
function renderPhotoMove(){const t=oldPhotoTargets();show($('photoMoveBox'),t.length>0);if(t.length)$('photoMoveInfo').textContent=`아직 기존 DB에 있는 사진·신분증 ${t.length}개. 누르면 새 DB로 복사하고 주소를 바꿉니다. 기존 파일은 지우지 않습니다.`}
$('photoMoveBtn').onclick=async()=>{const btn=$('photoMoveBtn'),log=$('photoMoveLog');btn.disabled=true;log.textContent='';let ok=0,bad=0;
  for(const {e,f} of oldPhotoTargets()){const label=`${e.name} ${f==='photo_url'?'사진':'신분증'}`;
    try{const path=photoPathFromUrl(e[f]);if(!path)throw new Error('주소 형식을 알 수 없음');const r=await fetch(e[f],{cache:'no-store'});if(!r.ok)throw new Error('내려받기 실패 '+r.status);const blob=await r.blob();
      const {error}=await sb.storage.from(PHOTO_BUCKET).upload(path,blob,{upsert:true,contentType:blob.type||undefined,cacheControl:'0'});if(error)throw error;
      const nu=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;const {error:ue}=await sb.from(EMP_TABLE).update({[f]:nu}).eq('id',e.id);if(ue)throw ue;e[f]=nu;ok++;log.textContent+=`✓ ${label}\n`}
    catch(err){bad++;log.textContent+=`✗ ${label}: ${err.message||err}\n`}}
  log.textContent+=`\n끝: 성공 ${ok}개 / 실패 ${bad}개`;btn.disabled=false;renderPhotoMove()};

// ===== v008: 피복 관리 · 서류(신분증·통장사본·기숙사 계약서) · 부서 묶음(산업전선/포장) =====
const UNI_ITEMS=['여름상의','여름하의','춘추하의','겨울하의','조끼','바람막이','후리스','패딩','안전화','안전장화','장화','안전방화','안전모','우비'];
const UNI_SIZE_FROM={'여름상의':'top_size','조끼':'top_size','바람막이':'top_size','패딩':'top_size','여름하의':'bottom_size','춘추하의':'bottom_size','겨울하의':'bottom_size','안전화':'shoe_size','안전장화':'shoe_size','장화':'shoe_size','안전방화':'shoe_size'};
let uniItems=new Map(),uniSizes=new Map(),uniReady=null,uniGroup='전체',deptRows=[],deptReady=false;
const uKey=(id,item)=>id+'|'+item;
// 부서 묶음: 부서 표(erp_departments)의 상위 값, 없으면 대한전선은 포장·마킹 → 포장, 나머지 → 산업전선
function deptParent(site,dept){const d=String(dept||'').trim();const r=deptRows.find(x=>x.site===site&&x.name===d);if(r)return r.parent||'';if(site!=='대한전선')return '';return /^(포장|마킹)/.test(d)?'포장':'산업전선'}
function groupOf(e){const s=siteOf(e);const p=deptParent(s,e.department);return p?`${s} ${p}`:s}
async function loadDepartments(){try{const {data,error}=await sb.from('erp_departments').select('site,name,parent,sort_no');if(error)throw error;deptRows=data||[];deptReady=true}catch(e){deptRows=[];deptReady=false}fillDeptDatalist()}
function fillDeptDatalist(){const dl=$('deptOptions');if(!dl)return;const site=$('site')?.value||'';const names=new Set(deptRows.filter(r=>!site||r.site===site).map(r=>r.name));employees.forEach(e=>{if((!site||siteOf(e)===site)&&String(e.department||'').trim())names.add(String(e.department).trim())});dl.innerHTML=[...names].sort((a,b)=>a.localeCompare(b,'ko')).map(n=>`<option value="${esc(n)}">`).join('')}
// ----- 서류 -----
function docV8Ready(){return !employees.length||Object.prototype.hasOwnProperty.call(employees[0],'doc_bank_submitted')}
function idDocOk(e){return docHasPhoto(e,'id')} // v015: 사진 있으면 있음
function bankDocOk(e){return docHasPhoto(e,'bank')||hasAccountNo(e)} // v030: 통장사본 없어도 계좌번호 있으면 됨
function hasAccountNo(e){return !!String(e.account_no||'').replace(/[^0-9]/g,'')}
function bankKind(e){return docHasPhoto(e,'bank')?'통장':hasAccountNo(e)?'계좌':''}
// ----- v010: 신분증·통장사본 사진 (비공개 보관함, 직원 폴더별) -----
const PRIVATE_BUCKET='erp-private-docs';
const CAM_SVG='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>';
function openDocMenu(btn){const m=$('docMenu');const id=btn.dataset.id,kind=btn.dataset.docmenu;const e=employees.find(x=>x.id===id);if(!e)return;
  m.dataset.id=id;m.dataset.kind=kind;$('docMenuTitle').textContent=`${e.name} · ${DOC_KIND[kind].label}`;show($('docMenuView'),docHasPhoto(e,kind));
  show(m,true);const r=btn.getBoundingClientRect();const mw=m.offsetWidth,mh=m.offsetHeight;
  if(window.innerWidth<=600){m.classList.add('sheet');m.style.left=m.style.top=''}else{m.classList.remove('sheet');m.style.left=Math.min(window.innerWidth-mw-8,Math.max(8,r.left))+'px';m.style.top=(r.bottom+mh+8>window.innerHeight?r.top-mh-6:r.bottom+6)+'px'}}
function closeDocMenu(){show($('docMenu'),false)}
function docPhotoReady(){return !employees.length||Object.prototype.hasOwnProperty.call(employees[0],'bank_doc_path')}
const DOC_KIND={id:{col:'id_doc_path',chk:'doc_id_submitted',label:'신분증'},bank:{col:'bank_doc_path',chk:'doc_bank_submitted',label:'통장사본'}};
function docHasPhoto(e,kind){return kind==='id'?!!(e.id_doc_path||e.id_document_url):!!e.bank_doc_path}
function docPhotoCell(e,kind){const k=DOC_KIND[kind];const ph=docHasPhoto(e,kind);
  const badge=ph?`<button type="button" class="b ok doc-view" data-docview="${kind}" data-id="${esc(e.id)}" title="사진 보기">${kind==='bank'?'통장':'있음'}</button>`:(kind==='bank'&&hasAccountNo(e))?`<span class="b ok" title="통장사본은 없고 계좌번호만 있음">계좌</span>`:'<span class="b no">없음</span>';
  const btns=`<button type="button" class="doc-ph-btn" data-docmenu="${kind}" data-id="${esc(e.id)}" title="${k.label} 사진" aria-label="${k.label} 사진 넣기">${CAM_SVG}</button>`;
  return `<div class="doc-ph">${badge}${docPhotoReady()?btns:''}</div>`}
async function compressImage(file){
  try{const bmp=await createImageBitmap(file);const max=1800;const r=Math.min(1,max/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*r);c.height=Math.round(bmp.height*r);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    const b=await new Promise(res=>c.toBlob(res,'image/jpeg',0.85));return b||file}catch(e){return file}}
let docShotTarget=null;
function startDocShot(mode,id,kind){docShotTarget={id,kind};const inp=$(mode==='cam'?'docCamInput':'docPickInput');inp.value='';inp.click()}
async function onDocShotFile(e){const f=e.target.files[0];const t=docShotTarget;docShotTarget=null;if(!f||!t)return;
  const emp=employees.find(x=>x.id===t.id);if(!emp)return;const k=DOC_KIND[t.kind];
  if(!/^image\//.test(f.type||'image/'))return alert('사진 파일만 넣을 수 있습니다.');
  const cell=document.querySelector(`[data-docmenu="${t.kind}"][data-id="${CSS.escape(t.id)}"]`)?.closest('.doc-ph');if(cell)cell.innerHTML='<span class="b gy">올리는 중...</span>';
  try{const blob=await compressImage(f);const path=`${emp.id}/${t.kind}-${Date.now()}.jpg`;
    const {error}=await sb.storage.from(PRIVATE_BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false});if(error)throw error;
    const {error:ue}=await sb.from(EMP_TABLE).update({[k.col]:path}).eq('id',emp.id);if(ue)throw ue;emp[k.col]=path;
  }catch(err){alert(`${k.label} 사진을 올리지 못했습니다: ${err.message||err}${/bucket|not found|row-level/i.test(String(err.message))?'\n(v010 SQL 설치가 필요할 수 있습니다)':''}`)}
  updateNavDocCount();renderDocsView()}
function openImageViewerUrl(url,title,filename){imageViewerUrl=url;imageViewerName=filename||'사진.jpg';$('imageViewerTitle').textContent=title||'사진 보기';$('imageViewerImg').src=url;$('imageViewer').classList.remove('hidden');$('imageViewer').setAttribute('aria-hidden','false')}
async function viewDocPhoto(id,kind){const e=employees.find(x=>x.id===id);if(!e)return;const k=DOC_KIND[kind];
  if(kind==='id'&&!e.id_doc_path&&e.id_document_url)return openImageViewerUrl(e.id_document_url,`${e.name} 신분증`,`${e.name}_신분증.jpg`);
  const {data,error}=await sb.storage.from(PRIVATE_BUCKET).createSignedUrl(e[k.col],600);if(error)return alert('사진을 열지 못했습니다: '+error.message);
  openImageViewerUrl(data.signedUrl,`${e.name} ${k.label}`,`${e.name}_${k.label}.jpg`)}
// ----- 피복 -----
async function loadUniform(){
  const [a,b]=await Promise.all([sb.from('erp_uniform_items').select('*'),sb.from('erp_uniform_sizes').select('employee_id,top_size,bottom_size,shoe_size,note')]);
  if(a.error||b.error){uniReady=false;return}
  uniItems=new Map((a.data||[]).map(r=>[uKey(r.employee_id,r.item),r]));uniSizes=new Map((b.data||[]).map(r=>[r.employee_id,r]));uniReady=true;p2Ready=!!(a.data&&a.data[0]&&Object.prototype.hasOwnProperty.call(a.data[0],'second_issued_on'));
}
function uniPeople(){return activeInCompany().sort((a,b)=>groupOf(a).localeCompare(groupOf(b),'ko')||String(a.hire_date||'9999').localeCompare(String(b.hire_date||'9999'))||a.name.localeCompare(b.name,'ko'))} // v038: 큰 묶음(산업전선/포장) → 입사일순
function uniDefaultSize(id,item){const s=uniSizes.get(id);const k=UNI_SIZE_FROM[item];return s&&k?s[k]||'':''}
// ----- v031: 바지(하의)는 첫 장 지급 후 14일 뒤 2장째 -----
const PANTS=['여름상의','여름하의','춘추하의','겨울하의'] /* v034: 여름상의도 2장 */,PANTS_DAYS=14;let p2Ready=false;
function pants2(r,item){if(!p2Ready||!PANTS.includes(item)||!r||r.status!=='지급')return null;if(r.second_issued_on)return {done:true};if(!r.issued_on)return null;const due=addDaysISO(r.issued_on,PANTS_DAYS);return {done:false,due,late:due<=localDateKey(today())}}
function pants2List(people){const out=[];people.forEach(e=>PANTS.forEach(i=>{const r=uniItems.get(uKey(e.id,i));const p=pants2(r,i);if(p&&!p.done)out.push({e,item:i,r,due:p.due,days:daysBetweenKeys(localDateKey(today()),p.due)})}));return out.sort((a,b)=>a.due.localeCompare(b.due)||a.e.name.localeCompare(b.e.name,'ko'))}
function daysBetweenKeys(a,b){const pa=isoParts(a),pb=isoParts(b);return Math.round((Date.UTC(pb.y,pb.m-1,pb.d)-Date.UTC(pa.y,pa.m-1,pa.d))/864e5)}
function renderPants2(people){const box=$('uniPants');if(!box)return;if(!p2Ready){box.innerHTML='';show(box,false);return}
  const all=pants2List(people),soon=all.filter(x=>x.days<=7);show(box,true);
  box.innerHTML=`<h3>2장째 줄 사람 <small>여름상의·하의, 첫 장 주고 ${PANTS_DAYS}일 뒤</small></h3>`+(soon.length?`<div class="p2-list">${soon.map(x=>`<div class="p2-row${x.days<=0?' late':''}"><b>${esc(x.e.name)}</b><span class="p2-dept">${esc(x.e.department||'')}</span><span>${esc(x.item)} ${esc(x.r.size||uniDefaultSize(x.e.id,x.item)||'')}</span><span class="p2-due">${x.days<0?`${-x.days}일 지남`:x.days===0?'오늘':`${x.days}일 뒤`} <small>${esc(x.due.slice(5).replace('-','/'))}</small></span><button type="button" class="ghost p2-give" data-p2-emp="${esc(x.e.id)}" data-p2-item="${esc(x.item)}">줬음</button></div>`).join('')}</div>`:'<div class="muted">이번 주에 줄 사람이 없습니다.</div>')+(all.length>soon.length?`<div class="muted p2-more">그 뒤 예정 ${all.length-soon.length}명</div>`:'')}
async function givePants2(id,item,date){const r=uniItems.get(uKey(id,item));if(!r)return;const d=date||localDateKey(today());
  const {data,error}=await sb.from('erp_uniform_items').update({second_issued_on:d}).eq('employee_id',id).eq('item',item).select().single();if(error)return alert('저장 실패: '+error.message);uniItems.set(uKey(id,item),data||{...r,second_issued_on:d});renderUniformView()}
function uniCell(id,item){const r=uniItems.get(uKey(id,item));if(!r)return {cls:'nr',label:'·',title:'기록 없음'};
  const size=r.size||'';if(r.status==='지급'){const p=pants2(r,item);
    if(p&&!p.done&&p.late)return {cls:'p2',label:'2장째',title:`2장째 줄 날 ${p.due} (첫 장 ${r.issued_on})`};
    return {cls:'ok',label:size||'✓',sub:p?(p.done?'2':'1'):'',title:'지급'+(r.issued_on?' '+r.issued_on:'')+(p?(p.done?` · 2장째 ${r.second_issued_on}`:` · 2장째 예정 ${p.due}`):'')}}
  if(r.status==='교체')return {cls:'wt',label:'교체',title:'교체 필요'+(r.note?' · '+r.note:'')};
  if(r.status==='보류')return {cls:'hd',label:size||'보류',title:'보류 (지금은 지급 안 해도 됨)'+(r.note?' · '+r.note:'')}; // v029
  return {cls:'no',label:size?size:'없음',title:'미지급'}}
function uniHasProblem(id){return UNI_ITEMS.some(i=>{const r=uniItems.get(uKey(id,i));return r&&r.status!=='지급'&&r.status!=='보류'})}
async function renderUniformView(){
  if(currentTab!=='피복')return;
  showErpView('uniformView');show($('addBtn'),false);
  if(uniReady===null){$('uniBody').innerHTML=`<tr><td colspan="${5+UNI_ITEMS.length}" class="dash-empty">불러오는 중...</td></tr>`;await loadUniform();if(currentTab!=='피복')return}
  show($('uniNotice'),uniReady===false);
  if(uniReady===false){$('uniNotice').textContent='피복 관리는 Supabase SQL(가나안ERP_v008_1_설치.sql)을 실행한 뒤 사용할 수 있습니다.';}
  const all=uniPeople();const groups=[...new Set(all.map(groupOf))];if(uniGroup!=='전체'&&!groups.includes(uniGroup))uniGroup='전체';
  $('uniGroups').innerHTML=['전체',...groups].map(g=>`<button type="button" data-uni-group="${esc(g)}" class="${g===uniGroup?'active':''}">${esc(g==='전체'?'전체':g.replace(/^대한전선 /,''))} ${g==='전체'?all.length:all.filter(e=>groupOf(e)===g).length}</button>`).join('');
  const inGroup=all.filter(e=>uniGroup==='전체'||groupOf(e)===uniGroup);
  const list=$('uniOnlyMissing').checked?inGroup.filter(e=>uniHasProblem(e.id)):inGroup;
  let no=0,wt=0,nr=0;const order={};
  inGroup.forEach(e=>UNI_ITEMS.forEach(i=>{const r=uniItems.get(uKey(e.id,i));if(!r){nr++;return}if(r.status==='지급'||r.status==='보류')return;if(r.status==='미지급')no++;else wt++;const sz=r.size||uniDefaultSize(e.id,i)||'사이즈 미정';(order[i]=order[i]||{})[sz]=(order[i][sz]||0)+1}));
  $('uniCards').innerHTML=`<div class="uni-card"><b>${inGroup.length}명</b><span>재직자</span></div><div class="uni-card red"><b>${no}건</b><span>미지급</span></div><div class="uni-card or"><b>${wt}건</b><span>교체 필요</span></div><div class="uni-card gy"><b>${nr}칸</b><span>기록 없음</span></div>`;
  renderPants2(inGroup);
  const oi=UNI_ITEMS.filter(i=>order[i]);
  $('uniOrder').innerHTML=`<h3>주문할 것 (미지급 + 교체)</h3>`+(oi.length?oi.map(i=>`<div><b>${esc(i)}</b> · ${Object.entries(order[i]).sort().map(([s,c])=>`${esc(s)} ${c}개`).join(', ')}</div>`).join(''):'<div class="muted">주문할 것이 없습니다.</div>');
  $('uniHead').innerHTML='<tr><th>이름</th><th>부서</th><th>상의</th><th>하의</th><th>신발</th>'+UNI_ITEMS.map(i=>`<th>${esc(i)}</th>`).join('')+'</tr>';
  const sz=(e,k)=>esc(uniSizes.get(e.id)?.[k]||'-');
  const gh=(e,i)=>{const g=groupOf(e);if(i&&groupOf(list[i-1])===g)return '';const n=list.filter(x=>groupOf(x)===g).length;return {g:g.replace(/^대한전선 /,''),n}};
  $('uniBody').innerHTML=list.length?list.map((e,ix)=>{const h=gh(e,ix);return (h?`<tr class="uni-grp"><td colspan="${5+UNI_ITEMS.length}">${esc(h.g)} <span>${h.n}명</span></td></tr>`:'')+`<tr><td class="uni-name"><button type="button" class="link-btn" data-uni-size="${esc(e.id)}">${esc(e.name)}</button></td><td class="uni-dept">${esc(e.department||'-')}</td><td class="uni-sz" data-uni-size="${esc(e.id)}">${sz(e,'top_size')}</td><td class="uni-sz" data-uni-size="${esc(e.id)}">${sz(e,'bottom_size')}</td><td class="uni-sz" data-uni-size="${esc(e.id)}">${sz(e,'shoe_size')}</td>`+UNI_ITEMS.map(i=>{const c=uniCell(e.id,i);return `<td><button type="button" class="uc ${c.cls}" title="${esc(i+' · '+c.title)}" data-uni-emp="${esc(e.id)}" data-uni-item="${esc(i)}">${esc(c.label)}${c.sub?`<i class="u2${c.sub==='2'?' d':''}">${c.sub}/2</i>`:''}</button></td>`}).join('')+'</tr>'}).join(''):`<tr><td colspan="${5+UNI_ITEMS.length}" class="dash-empty">${$('uniOnlyMissing').checked?'미지급·교체가 없습니다.':'표시할 직원이 없습니다.'}</td></tr>`;
  $('uniMobile').innerHTML=list.length?list.map((e,ix)=>{const h=gh(e,ix);const H=h?`<div class="uni-grp-m">${esc(h.g)} <span>${h.n}명</span></div>`:'';const s=uniSizes.get(e.id)||{};return H+`<div class="uni-pc"><div class="uni-pc-h"><b>${esc(e.name)}</b><span>${esc(e.department||'')}</span></div><button type="button" class="uni-pc-s" data-uni-size="${esc(e.id)}">상의 ${esc(s.top_size||'-')} · 하의 ${esc(s.bottom_size||'-')} · 신발 ${esc(s.shoe_size||'-')} ✎</button><div class="uni-pc-its">`+UNI_ITEMS.map(i=>{const c=uniCell(e.id,i);const mark=c.cls==='ok'?'✓'+(c.sub?` ${c.sub}/2`:''):c.cls==='no'?'✗':c.cls==='wt'?'교체':c.cls==='p2'?'2장째':c.cls==='hd'?'보류':'·';return `<button type="button" class="uc ${c.cls}" data-uni-emp="${esc(e.id)}" data-uni-item="${esc(i)}">${esc(i)} ${mark}</button>`}).join('')+'</div></div>'}).join(''):'<div class="empty">표시할 직원이 없습니다.</div>';
}
let uniEditing=null;
function openUniItem(id,item){if(!uniReady)return alert('먼저 v008 SQL을 설치하세요.');const e=employees.find(x=>x.id===id);if(!e)return;const r=uniItems.get(uKey(id,item))||{};uniEditing={kind:'item',id,item};
  $('uniModalTitle').textContent=`${e.name} · ${item}`;
  const st=r.status||'지급';
  $('uniModalBody').innerHTML=`<div class="uni-status">${['지급','미지급','교체','보류'].map(s=>`<label class="uni-st ${s==='지급'?'ok':s==='미지급'?'no':s==='교체'?'wt':'hd'}"><input type="radio" name="uniSt" value="${s}" ${s===st?'checked':''}> ${s==='교체'?'교체 필요':s}</label>`).join('')}</div>
  <div class="form-grid uni-form"><label>사이즈<input id="uniSize" value="${esc(r.size??uniDefaultSize(id,item))}" placeholder="예: 105, XL, 260"></label><label>지급일<input id="uniDate" type="date" value="${esc(r.issued_on||'')}"></label>${p2Ready&&PANTS.includes(item)?`<div class="wide uni-cnt"><label class="uni-cn"><input type="radio" name="uniCnt" value="1" ${r.second_issued_on?'':'checked'}> 1장 지급<small>${r.issued_on&&!r.second_issued_on?' · 2장째 예정 '+esc(addDaysISO(r.issued_on,PANTS_DAYS).slice(5).replace('-','/')):''}</small></label><label class="uni-cn"><input type="radio" name="uniCnt" value="2" ${r.second_issued_on?'checked':''}> 2장 지급</label></div><label id="uniDate2Wrap" class="${r.second_issued_on?'':'hidden'}">2장째 지급일 <small class="muted">(모르면 비워 두기)</small><input id="uniDate2" type="date" value="${esc(r.second_issued_on||'')}"></label>`:''}<label class="wide">메모<input id="uniNote" value="${esc(r.note||'')}" placeholder="예: 사이즈 작음, 찢어짐"></label></div>
  ${r.updated_at?`<p class="muted uni-upd">마지막 수정 ${esc(fmtDT(r.updated_at))}</p>`:''}`;
  document.querySelectorAll('input[name="uniCnt"]').forEach(x=>x.onchange=()=>show($('uniDate2Wrap'),x.value==='2'&&x.checked));
  show($('uniModal'),true)}
function openUniSizes(id){if(!uniReady)return alert('먼저 v008 SQL을 설치하세요.');const e=employees.find(x=>x.id===id);if(!e)return;const s=uniSizes.get(id)||{};uniEditing={kind:'size',id};
  $('uniModalTitle').textContent=`${e.name} · 기본 사이즈`;
  $('uniModalBody').innerHTML=`<div class="form-grid uni-form"><label>상의<input id="uniTop" value="${esc(s.top_size||'')}" placeholder="예: 105"></label><label>하의<input id="uniBottom" value="${esc(s.bottom_size||'')}" placeholder="예: 34"></label><label>신발<input id="uniShoe" value="${esc(s.shoe_size||'')}" placeholder="예: 260"></label><label class="wide">메모<input id="uniSizeNote" value="${esc(s.note||'')}"></label></div><p class="muted">새 품목을 지급할 때 이 사이즈가 먼저 채워집니다.</p>`;
  show($('uniModal'),true)}
function closeUni(){show($('uniModal'),false);uniEditing=null}
async function saveUni(){const ed=uniEditing;if(!ed)return;const btn=$('uniModalSave');btn.disabled=true;
  try{
    if(ed.kind==='item'){const status=document.querySelector('input[name="uniSt"]:checked')?.value||'지급';let date=$('uniDate').value||null;
      const prev=uniItems.get(uKey(ed.id,ed.item));if(status==='지급'&&!date&&prev?.status!=='지급')date=localDateKey(today());
      const row={employee_id:ed.id,item:ed.item,size:$('uniSize').value.trim()||null,status,issued_on:date,note:$('uniNote').value.trim()||null};if($('uniDate2')){const two=document.querySelector('input[name="uniCnt"]:checked')?.value==='2';let d2=$('uniDate2').value||null;if(two&&!d2){const due=date?addDaysISO(date,PANTS_DAYS):'';const t=localDateKey(today());d2=due&&due<=t?due:(date||t)}row.second_issued_on=two?d2:null}
      const {data,error}=await sb.from('erp_uniform_items').upsert(row,{onConflict:'employee_id,item'}).select().single();if(error)throw error;uniItems.set(uKey(ed.id,ed.item),data||row)}
    else{const row={employee_id:ed.id,top_size:$('uniTop').value.trim()||null,bottom_size:$('uniBottom').value.trim()||null,shoe_size:$('uniShoe').value.trim()||null,note:$('uniSizeNote').value.trim()||null};
      const {data,error}=await sb.from('erp_uniform_sizes').upsert(row,{onConflict:'employee_id'}).select().single();if(error)throw error;uniSizes.set(ed.id,data||row)}
    closeUni();renderUniformView();
  }catch(e){alert('저장 실패: '+(e.message||e)+(/status_check/.test(String(e.message))?'\n(\'보류\'는 v029 SQL을 실행한 뒤 쓸 수 있습니다)':''))}finally{btn.disabled=false}}
async function exportUniform(){
  if(!window.ExcelJS)return alert('엑셀 기능을 불러오지 못했습니다.');
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('피복 현황');
  ws.columns=[{header:'이름',width:10},{header:'회사·묶음',width:14},{header:'부서',width:14},{header:'상의',width:7},{header:'하의',width:7},{header:'신발',width:7},...UNI_ITEMS.map(i=>({header:i,width:10}))];
  const fill={ok:'FFDCFCE7',no:'FFFEE2E2',wt:'FFFEF3C7',hd:'FFE5E7EB'};
  uniPeople().forEach(e=>{const s=uniSizes.get(e.id)||{};const row=ws.addRow([e.name,groupOf(e),e.department||'',s.top_size||'',s.bottom_size||'',s.shoe_size||'',...UNI_ITEMS.map(i=>{const r=uniItems.get(uKey(e.id,i));return r?`${r.size?r.size+' ':''}${r.status}`:''})]);
    UNI_ITEMS.forEach((i,k)=>{const r=uniItems.get(uKey(e.id,i));const c=r?(r.status==='지급'?'ok':r.status==='미지급'?'no':r.status==='보류'?'hd':'wt'):null;if(c)row.getCell(7+k).fill={type:'pattern',pattern:'solid',fgColor:{argb:fill[c]}}})});
  ws.getRow(1).font={bold:true};ws.views=[{state:'frozen',ySplit:1,xSplit:1}];
  const buf=await wb.xlsx.writeBuffer();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([buf]));a.download=`피복현황_${localDateKey(today())}.xlsx`;document.body.appendChild(a);a.click();a.remove();
}
function initUniform(){
  $('uniformView').addEventListener('click',e=>{const g=e.target.closest('[data-uni-group]');if(g){uniGroup=g.dataset.uniGroup;renderUniformView();return}
    const g2=e.target.closest('[data-p2-emp]');if(g2){givePants2(g2.dataset.p2Emp,g2.dataset.p2Item);return}
    const it=e.target.closest('[data-uni-item]');if(it){openUniItem(it.dataset.uniEmp,it.dataset.uniItem);return}
    const sz=e.target.closest('[data-uni-size]');if(sz)openUniSizes(sz.dataset.uniSize)});
  $('uniOnlyMissing').onchange=renderUniformView;$('uniExport').onclick=()=>exportUniform().catch(e=>alert('엑셀 만들기 실패: '+e.message));
  $('uniModalClose').onclick=closeUni;$('uniModalCancel').onclick=closeUni;$('uniModalSave').onclick=saveUni;
  $('uniModal').addEventListener('click',e=>{if(e.target===$('uniModal'))closeUni()});
  $('site').addEventListener('change',fillDeptDatalist);
}
// ----- 부서 관리 화면 이벤트 (v009) -----
async function addDeptInline(form){
  if(!deptReady)return deptToast('부서 추가는 v008 SQL을 설치한 뒤 사용할 수 있습니다.',true);
  const g=form.closest('.dept-group');const site=g.dataset.site,parent=g.dataset.parent||null;const inp=form.querySelector('input');const name=inp.value.trim();if(!name)return inp.focus();
  if(deptRows.some(r=>r.site===site&&r.name===name)||employees.some(e=>siteOf(e)===site&&String(e.department||'').trim()===name))return deptToast('이미 있는 부서입니다.',true);
  const max=Math.max(0,...deptRows.filter(r=>r.site===site&&(r.parent||null)===parent&&r.sort_no<9999).map(r=>r.sort_no));
  const {error}=await sb.from('erp_departments').insert({site,name,parent,sort_no:max+1});
  if(error)return deptToast('추가 실패: '+error.message,true);
  deptToast(`'${name}' 부서를 추가했습니다.`);await loadDepartments();renderDeptView();
  [...$('deptList').querySelectorAll('.dept-group')].find(x=>x.dataset.site===site&&x.dataset.parent===(parent||''))?.querySelector('.dept-add input')?.focus();
}
async function changeDeptParent(site,name,parent){
  const {error}=await sb.from('erp_departments').upsert({site,name,parent,sort_no:9999},{onConflict:'site,name'});if(error)return deptToast('변경 실패: '+error.message,true);
  deptToast(`'${name}' → ${parent}`);await loadDepartments();renderDeptView();
}
async function deleteDept(site,name){
  if(!confirm(`빈 부서 '${name}'을(를) 지울까요?`))return;
  const {error}=await sb.from('erp_departments').delete().eq('site',site).eq('name',name);
  if(error)return deptToast(/permission|42501/.test(error.message+error.code)?'지우기는 v009 SQL을 설치한 뒤 됩니다.':'지우기 실패: '+error.message,true);
  await loadDepartments();renderDeptView();
}
function initDeptView(){
  const box=$('deptList');
  box.addEventListener('click',e=>{const row=e.target.closest('.dept-row');if(!row)return;
    if(e.target.closest('.dept-del'))deleteDept(row.dataset.site,row.dataset.name)});
  box.addEventListener('change',e=>{const row=e.target.closest('.dept-row');if(!row)return;
    if(e.target.classList.contains('dept-name'))renameDept(row.dataset.site,e.target.dataset.old,e.target.value);
    else if(e.target.classList.contains('dept-parent'))changeDeptParent(row.dataset.site,row.dataset.name,e.target.value)});
  box.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('dept-name')){e.preventDefault();e.target.blur()}if(e.key==='Escape'&&e.target.classList.contains('dept-name')){e.target.value=e.target.dataset.old;e.target.blur()}});
  box.addEventListener('submit',e=>{const f=e.target.closest('.dept-add');if(f){e.preventDefault();addDeptInline(f)}});
}

$('photoPreview').onclick=()=>openImageViewerFromPreview('photoPreview','직원 사진',`${currentEmployee?.name||'직원'}_사진.jpg`);
$('idDocPreview').onclick=()=>openImageViewerFromPreview('idDocPreview','신분증 / 여권',`${currentEmployee?.name||'직원'}_신분증여권.jpg`);
if($('imageViewerClose'))$('imageViewerClose').onclick=closeImageViewer;
if($('imageViewerCloseBottom'))$('imageViewerCloseBottom').onclick=closeImageViewer;
if($('imageViewerSave'))$('imageViewerSave').onclick=saveViewedImage;
if($('imageViewer'))$('imageViewer').addEventListener('click',e=>{if(e.target===$('imageViewer'))closeImageViewer()});
document.addEventListener('keydown',e=>{const v=$('imageViewer');if(e.key==='Escape'&&v&&!v.classList.contains('hidden'))closeImageViewer()});


$('calendarPrev').onclick=()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()-1,1);renderCalendar()};
$('calendarNext').onclick=()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,1);renderCalendar()};
$('calendarToday').onclick=()=>{const n=new Date();calendarMonth=new Date(n.getFullYear(),n.getMonth(),1);renderCalendar()};
$('calendarTypeFilter').onchange=e=>{calendarTypeFilter=e.target.value;renderCalendar()};
$('calendarAddBtn').onclick=()=>openCalendarEventModal();
$('calendarEventClose').onclick=closeCalendarEventModal;
$('calendarEventCancel').onclick=closeCalendarEventModal;
$('calendarEventForm').onsubmit=saveCalendarEvent;
$('calendarEventDelete').onclick=deleteCalendarEvent;
$('calendarEventModal').addEventListener('click',e=>{if(e.target===$('calendarEventModal'))closeCalendarEventModal()});

$('contractAutoBtn').onclick=autoGenerateContracts;
$('contractAddBtn').onclick=addContractHistoryRow;
$('hireDate').addEventListener('change',()=>{updateHandoverVisibility();refreshAnnualLeaveSummary()});
$('annualLeaveAutoBtn').onclick=autoGenerateAnnualLeave;
$('annualLeaveGrantedInput').addEventListener('input',()=>refreshAnnualLeaveSummary({preserveGrantedInput:true,preserveExtraInput:true}));
$('annualLeaveCarryoverInput').addEventListener('input',()=>refreshAnnualLeaveSummary({preserveGrantedInput:true,preserveExtraInput:true}));
$('calendarEventType').addEventListener('change',()=>{updateCalendarLeaveFields();syncAnnualLeaveTitle()});
$('calendarLeaveEmployee').addEventListener('change',syncAnnualLeaveTitle);
$('leaveHistorySearch').addEventListener('input',renderAnnualLeaveHistory);
$('leaveHistoryYear').addEventListener('change',renderAnnualLeaveHistory);
$('nationalityLocal').addEventListener('change',()=>setNationality('local',{clearVisa:true}));
$('nationalityForeign').addEventListener('change',()=>setNationality('foreign'));
$('contractStageClose').onclick=closeContractStageModal;
$('contractStageCancel').onclick=closeContractStageModal;
$('contractStageModal').addEventListener('click',e=>{if(e.target===$('contractStageModal'))closeContractStageModal()});
$('contractStageButtons').addEventListener('click',e=>{const b=e.target.closest('[data-contract-stage]');if(b)applyContractStage(b.dataset.contractStage)});
$('logoutBtn').onclick=()=>sb.auth.signOut();$('addBtn').onclick=openNew;$('closeModal').onclick=closeModal;$('cancelModal').onclick=closeModal;$('employeeForm').onsubmit=saveEmployee;$('photoDeleteBtn').onclick=deletePhoto;$('idDocDeleteBtn').onclick=deleteIdDocument;$('terminateBtn').onclick=terminate;$('restoreBtn').onclick=restore;$('deleteBtn').onclick=permanentDelete;$('exportBtn').onclick=exportExcel;$('searchInput').oninput=render;document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{listFilter='';if(b.dataset.site==='피복')uniReady=null;goTab(b.dataset.site)});function goTab(tab){document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('active',x.dataset.site===tab));currentTab=tab;window.scrollTo(0,0);if((currentTab==='달력'||currentTab==='연차현황')&&!calendarEvents.length&&!calendarLoadError)loadCalendarEvents(true).then(()=>currentTab==='달력'?renderCalendar():renderAnnualLeaveHistory());else render()}function previewSelectedImage(inputId,otherInputId,previewId){const input=$(inputId);const other=$(otherInputId);input.onchange=e=>{const f=e.target.files[0];if(!f)return;if(other)other.value='';const u=URL.createObjectURL(f);$(previewId).innerHTML=`<img src="${u}">`;};}
previewSelectedImage('photoFile','photoCameraFile','photoPreview');
previewSelectedImage('photoCameraFile','photoFile','photoPreview');
previewSelectedImage('idDocFile','idDocCameraFile','idDocPreview');
previewSelectedImage('idDocCameraFile','idDocFile','idDocPreview');
['notes','workHistory'].forEach(id=>$(id).addEventListener('input',e=>autoGrow(e.target)));resizeMemoFields();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;show($('installBtn'))});$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;show($('installBtn'),false)}};
if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
initErp();
initUniform();
initDeptView();
initListView();
initLeaveView();
init();
// ----- v020: 신분증 여러 장 한번에 넣기 (파일 이름 = 직원 이름) -----
let bulkIdPlan=[];
function openBulkId(){if(!docPhotoReady())return alert('신분증 사진 기능은 v010 SQL 설치 뒤 사용할 수 있습니다.');bulkIdPlan=[];$('bulkIdFiles').value='';$('bulkIdList').innerHTML='';$('bulkIdMsg').textContent='';$('bulkIdGo').disabled=true;show($('bulkIdModal'),true)}
function bulkNameOf(f){return String(f.name||'').replace(/\.[^.]+$/,'').replace(/[\s_-]*(신분증|\(\d+\)|\d+)$/,'').replace(/\s+/g,'').trim()}
function bulkKind(){return document.querySelector('input[name="bulkKind"]:checked')?.value||'id'}
function onBulkIdFiles(e){const files=[...e.target.files];const face=bulkKind()==='face';const pool=employees.filter(inCompany);
  bulkIdPlan=files.map(f=>{const n=bulkNameOf(f);let hits=pool.filter(x=>String(x.name||'').replace(/\s+/g,'')===n);if(hits.length>1){const act=hits.filter(x=>!isTerminated(x));if(act.length===1)hits=act}
    const emp=hits.length===1?hits[0]:null;let st,cls;
    if(!hits.length){st='이름 못 찾음';cls='no'}else if(hits.length>1){st=`같은 이름 ${hits.length}명 → 건너뜀`;cls='no'}else if(face?emp.photo_url:emp.id_doc_path){st='이미 있음 → 건너뜀';cls='gy'}else{st='넣을 예정';cls='ok'}
    return {file:f,name:n,emp:cls==='ok'?emp:null,info:emp,st,cls,face}});
  bulkIdPlan.sort((a,b)=>(a.cls!=='ok')-(b.cls!=='ok')||a.name.localeCompare(b.name,'ko'));
  drawBulkId()}
function drawBulkId(){const n=bulkIdPlan.filter(p=>p.emp).length;
  $('bulkIdList').innerHTML=bulkIdPlan.length?`<table class="erp-table"><thead><tr><th>파일</th><th>직원</th><th>상태</th></tr></thead><tbody>${bulkIdPlan.map(p=>`<tr><td>${esc(p.file.name)}</td><td>${p.info?esc(p.info.name)+' <small class="muted">'+esc(siteOf(p.info))+(isTerminated(p.info)?' · 퇴사':'')+'</small>':'-'}</td><td><span class="b ${p.cls}">${esc(p.st)}</span></td></tr>`).join('')}</tbody></table>`:'';
  $('bulkIdMsg').textContent=bulkIdPlan.length?`${bulkIdPlan.length}장 중 ${n}장 넣을 수 있음`:'';$('bulkIdGo').disabled=!n}
async function runBulkId(){const btn=$('bulkIdGo');btn.disabled=true;let ok=0,bad=0;
  for(const p of bulkIdPlan){if(!p.emp)continue;p.st='올리는 중...';p.cls='gy';drawBulkId();btn.disabled=true;
    try{const blob=await compressImage(p.file);
      if(p.face){const path=`${p.emp.id}/${Date.now()}-face.jpg`;const {error}=await sb.storage.from(PHOTO_BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false,cacheControl:'0'});if(error)throw error;
        const url=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;const {error:ue}=await sb.from(EMP_TABLE).update({photo_url:url}).eq('id',p.emp.id);if(ue)throw ue;p.emp.photo_url=url}
      else{const path=`${p.emp.id}/id-${Date.now()}.jpg`;
      const {error}=await sb.storage.from(PRIVATE_BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false});if(error)throw error;
      const {error:ue}=await sb.from(EMP_TABLE).update({id_doc_path:path}).eq('id',p.emp.id);if(ue)throw ue;p.emp.id_doc_path=path}p.st='완료';p.cls='ok';ok++}
    catch(err){p.st='실패: '+(err.message||err);p.cls='no';bad++}
    p.emp=null}
  drawBulkId();$('bulkIdMsg').textContent=`완료 ${ok}장${bad?` · 실패 ${bad}장 (다시 고르면 실패한 것만 넣을 수 있어요)`:''}`;updateNavDocCount();renderDocsView()}
// ───── v024 가나안요청 연동 (관리자) ─────
let linkData=null;
const LINK_RESULT={'반영':['ok','반영'],'이미있음':['gy','이미 있음'],'확인필요':['wt','확인 필요'],'넘김':['gy','넘김'],'취소됨':['no','가나안요청에서 취소'],'취소확인':['gy','취소 확인함']};
function linkMsg(t,isErr){const el=$('linkMsg');el.textContent=t;el.style.color=isErr?'#b91c1c':'';show(el,!!t)}
function linkEmpLabel(id){const e=employees.find(x=>x.id===id);return e?`${e.name} · ${siteOf(e)}${e.department?' '+e.department:''}`:'-'}
function linkTarget(r){
  if(r.result==='반영')return r.kind==='피복'?`피복 관리 · ${r.item}${r.size?' '+r.size:''} 지급${r.reason?' ('+r.reason+')':''}`:`공유달력 · 연차 ${Number(r.leave_days)}일`;
  return r.reason||LINK_RESULT[r.result]?.[1]||r.result}
function linkOptions(r){const k=String(r.person||'').replace(/\s+/g,'');const act=employees.filter(e=>!isTerminated(e));
  const same=act.filter(e=>e.name.replace(/\s+/g,'')===k);const rest=act.filter(e=>!same.includes(e)).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  const o=e=>`<option value="${esc(e.id)}">${esc(e.name)} · ${esc(siteOf(e))}${e.department?' '+esc(e.department):''}</option>`;
  return `<option value="">직원 고르기…</option>${same.length?`<optgroup label="같은 이름">${same.map(o).join('')}</optgroup>`:''}<optgroup label="재직자 전체">${rest.map(o).join('')}</optgroup>`}
async function refreshLinkCount(){try{const d=await api('/api/link/status',{});linkData=d;const n=d.open.length;$('navLinkCount').textContent=n;show($('navLinkCount'),n>0)}catch(e){show($('navLinkCount'),false)}}
async function renderLinkView(fetchNew=true){
  if(currentTab!=='연동')return;
  showErpView('linkView');show($('addBtn'),false);
  if(myAccount?.role!=='관리자'){$('linkOpen').innerHTML='<tr><td colspan="6">admin만 볼 수 있습니다.</td></tr>';return}
  if(fetchNew||!linkData){$('linkState').textContent='불러오는 중...';try{linkData=await api('/api/link/status',{})}catch(e){$('linkState').textContent=e.message;$('linkOpen').innerHTML='';$('linkRecent').innerHTML='';$('linkCards').innerHTML='';return}}
  const d=linkData,st=d.state||{};
  $('linkState').innerHTML=!d.configured?'<span class="b no">아직 연결 안 됨</span> Cloudflare에 가나안요청 키(REQ_SUPABASE_KEY)를 넣어야 가져올 수 있습니다.'
    :`<b>마지막으로 가져온 시각</b> ${esc(st.last_run_at?new Date(st.last_run_at).toLocaleString('ko-KR',{month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}):'아직 없음')} ${st.last_message?`<span class="${st.last_ok===false?'err':'muted'}">(${esc(st.last_message)})</span>`:''}`;
  const ym=ymdLocal(today()).slice(0,7),thisMonth=d.recent.filter(r=>String(r.source_date||'').startsWith(ym)||String(r.updated_at||'').startsWith(ym));
  const cnt=(k,res)=>thisMonth.filter(r=>r.kind===k&&res.includes(r.result)).length;
  $('linkCards').innerHTML=`<div class="uni-card"><b style="color:#166534">${cnt('피복',['반영'])}건</b><span>피복 반영 (이번 달)</span></div><div class="uni-card"><b style="color:#166534">${cnt('연차',['반영'])}건</b><span>연차·반차 반영 (이번 달)</span></div><div class="uni-card or"><b>${d.open.length}건</b><span>확인 필요</span></div><div class="uni-card gy"><b>${thisMonth.filter(r=>r.result==='넘김').length}건</b><span>넘기지 않음 (이번 달)</span></div>`;
  $('navLinkCount').textContent=d.open.length;show($('navLinkCount'),d.open.length>0);
  $('linkOpen').innerHTML=d.open.map(r=>`<tr><td>${esc(String(r.source_date||'').slice(5))}</td><td>${esc(r.kind)}</td><td>${esc(r.content||'')}</td><td><b>${esc(r.person||'')}</b></td><td><span class="b ${r.result==='취소됨'?'no':'wt'}">${esc(r.result==='취소됨'?(r.reason||'').split(' · ')[0]:r.reason||'확인 필요')}</span>${r.result==='취소됨'&&r.employee_id?`<br><small>${esc(linkEmpLabel(r.employee_id))} · ERP 기록은 그대로 있음</small>`:''}</td>
    <td><div class="acc-actions">${r.result==='취소됨'?`<button type="button" class="ghost" data-link-ack="${r.id}">확인함</button>`:`<select data-link-emp="${r.id}">${linkOptions(r)}</select><button type="button" class="success" data-link-resolve="${r.id}">반영</button><button type="button" class="ghost" data-link-skip="${r.id}">넘기지 않기</button>`}</div></td></tr>`).join('')||'<tr><td colspan="6" class="dash-empty">확인할 것이 없습니다.</td></tr>';
  const hide=$('linkHideSkip').checked,rows=d.recent.filter(r=>!hide||r.result!=='넘김');
  $('linkRecent').innerHTML=rows.map(r=>{const [c,l]=LINK_RESULT[r.result]||['gy',r.result];return `<tr><td>${esc(String(r.source_date||'').slice(5))}</td><td>${esc(r.kind)}</td><td>${r.employee_id?esc(linkEmpLabel(r.employee_id)):`<small>${esc(r.person||'')}</small>`}</td><td>${esc(r.content||'')}</td><td><span class="b ${c}">${esc(r.result==='반영'?linkTarget(r):l)}</span>${r.result!=='반영'&&r.reason?` <small>${esc(r.reason)}</small>`:''}</td></tr>`}).join('')||'<tr><td colspan="5" class="dash-empty">아직 가져온 기록이 없습니다.</td></tr>';
}
function ymdLocal(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
$('linkHideSkip').onchange=()=>renderLinkView(false);
$('linkRunBtn').onclick=async()=>{const b=$('linkRunBtn');b.disabled=true;b.textContent='가져오는 중...';linkMsg('');
  try{const r=await api('/api/link/run',{});linkMsg(r.skipped?r.message:'가져오기 끝: '+r.message);uniReady=null;await loadCalendarEvents(true)}catch(e){linkMsg(e.message,true)}
  b.disabled=false;b.textContent='지금 가져오기';renderLinkView()};
$('linkOpen').onclick=async e=>{const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.linkResolve){const id=b.dataset.linkResolve;const emp=document.querySelector(`[data-link-emp="${id}"]`).value;if(!emp)return alert('직원을 골라주세요.');
      const r=linkData.open.find(x=>String(x.id)===id);if(!confirm(`'${r.person}' → ${linkEmpLabel(emp)}\n이 직원으로 반영할까요? 다음부터 '${r.person}'은(는) 이 직원으로 자동 반영됩니다.`))return;
      const res=await api('/api/link/resolve',{id:Number(id),employee_id:emp});linkMsg(res.result==='반영'?'반영했습니다.':'처리했습니다: '+(res.reason||res.result));uniReady=null;await loadCalendarEvents(true)}
    else if(b.dataset.linkSkip){if(!confirm('이 건은 ERP에 넣지 않고 넘길까요?'))return;await api('/api/link/skip',{id:Number(b.dataset.linkSkip)});linkMsg('넘겼습니다.')}
    else if(b.dataset.linkAck){await api('/api/link/ack',{id:Number(b.dataset.linkAck)});linkMsg('확인함으로 표시했습니다. ERP 기록은 필요하면 피복 관리·공유달력에서 직접 고쳐주세요.')}
    renderLinkView();
  }catch(err){linkMsg(err.message,true)}};

// ----- v032: 서명 만들기 (한글 서명 양식과 같은 카드 → PNG 저장) -----
// v041: 회사 두 곳(가나안산업·시온산업). 회사마다 로고·기본 주소가 다름
const SIGN_COMPANIES={'가나안':{label:'(주)가나안산업',logo:'erp-sign-logo.png',email:'이름@canaan-one.com',fixed:{tel:'031) 617-9366',fax:'031) 617-9367',office:'경기 평택시 평택 5로 20번길 37, 광안빌딩 3F',factory:'경기 평택시 산단로 52번길 45'}},
  '시온':{label:'(주)시온산업',logo:'erp-sign-logo-zion.png',email:'이름@zion-one.com',fixed:{tel:'031) 617-9366',fax:'031) 617-9367',office:'충남 당진시 참샘울길 50, 202호',factory:'경기 평택시 산단로 52번길 45'}}};
const SIGN_FIXED_DEFAULT=SIGN_COMPANIES['가나안'].fixed;
function signCo(c){return SIGN_COMPANIES[c]?c:'가나안'}
function signCompanyNow(){return signCo($('signCompany')?.value)}
const SIGN_FIXED_IDS={tel:'signTel',fax:'signFax',office:'signOffice',factory:'signFactory'};
const SIGN_FONT="'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR','Noto Sans CJK KR',sans-serif";
let signLogos={},signBound=false,signHasCompany=false,signSaved=[],signSavedReady=null,signEditId=null,signHasAddr=false;
function signFixKey(c){return signCo(c)==='가나안'?'erpSignFixed':'erpSignFixed_'+signCo(c)}
function signFixed(c){c=signCo(c||signCompanyNow());let o={};try{o=JSON.parse(localStorage.getItem(signFixKey(c))||'{}')||{}}catch(e){}return {...SIGN_COMPANIES[c].fixed,...o}}
function signData(){const v=id=>($(id)?.value||'').trim();return {company:signCompanyNow(),team:v('signTeam'),title:v('signTitle'),name:v('signName'),mobile:v('signMobile'),email:v('signEmail'),tel:v('signTel'),fax:v('signFax'),office:v('signOffice'),factory:v('signFactory')}}
function drawSignCard(cv,d){
  const S=3,H=150,logo=signLogos[signCo(d.company)];let lh=124,lw=logo?logo.naturalWidth*lh/logo.naturalHeight:143;if(lw>170){lh=lh*170/lw;lw=170}
  const m=document.createElement('canvas').getContext('2d'),f=(sz,w)=>`${w} ${sz}px ${SIGN_FONT}`;
  const line1=[d.team,d.title].filter(Boolean).join(' / ');
  const name=String(d.name||'').replace(/\s+/g,'').split('').join(' ');
  const tfm=[d.tel&&'T : '+d.tel,d.fax&&'F : '+d.fax,d.mobile&&'M : '+d.mobile].filter(Boolean).join('    ');
  const rows=[[line1,28,13,700],[name,53,19,800],[tfm,81,14,500]];
  // v040: E-mail·사무소·공장은 라벨 칸 너비를 맞춰 ':' 과 내용이 한 줄(세로)로 맞게
  const lab=[[d.email,'E-mail',105,500],[d.office,'사무소',123,700],[d.factory,'공장',141,700]].filter(r=>r[0]);
  let LW=0;lab.forEach(r=>{m.font=f(12,r[3]);LW=Math.max(LW,m.measureText(r[1]==='공장'?'사무소':r[1]).width)});
  m.font=f(12,700);const CW=m.measureText(' : ').width;
  const lx=Math.round(12+lw+12)+.5,x=lx+14;
  let tw=0;rows.forEach(r=>{if(r[0]){m.font=f(r[2],r[3]);tw=Math.max(tw,m.measureText(r[0]).width)}});
  lab.forEach(r=>{m.font=f(12,r[3]);tw=Math.max(tw,LW+CW+m.measureText(r[0]).width)});
  const W=Math.max(420,Math.ceil(x+tw+20));
  cv.width=W*S;cv.height=H*S;cv.style.aspectRatio=`${W}/${H}`;
  const c=cv.getContext('2d');c.scale(S,S);c.fillStyle='#fff';c.fillRect(0,0,W,H);
  if(logo)c.drawImage(logo,12,(H-lh)/2,lw,lh);
  c.strokeStyle='#222';c.lineWidth=1;c.beginPath();c.moveTo(lx,12);c.lineTo(lx,H-12);c.stroke();
  c.fillStyle='#111';rows.forEach(r=>{if(r[0]){c.font=f(r[2],r[3]);c.fillText(r[0],x,r[1])}});
  lab.forEach(([val,label,y,w])=>{c.font=f(12,w);
    if(label==='공장'){c.textAlign='left';c.fillText('공',x,y);c.textAlign='right';c.fillText('장',x+LW,y);c.textAlign='left'}
    else c.fillText(label,x,y);
    c.fillText(' : '+val,x+LW,y)});
}
function signRedraw(){const cv=$('signCanvas');if(!cv)return;drawSignCard(cv,signData())}
function signFileName(){const n=($('signName')?.value||'').trim().replace(/[\\/:*?"<>|\s]+/g,'');return `서명_${n||'카드'}.png`}
function signMsg(t){if($('signMsg'))$('signMsg').textContent=t||''}
function signFillEmployees(){
  const sel=$('signEmp');if(!sel)return;const keep=sel.value;
  const list=employees.filter(e=>!isTerminated(e)).filter(inCompany).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  sel.innerHTML='<option value="">— 직접 입력 —</option>'+list.map(e=>`<option value="${esc(e.id)}">${esc(e.name)}${e.department?' · '+esc(deptLabel(e)||e.department):''}</option>`).join('');
  if(list.some(e=>String(e.id)===keep))sel.value=keep;
}
function bindSignView(){
  if(signBound)return;signBound=true;
  const fx=signFixed();Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>{$(id).value=fx[k]});
  ['signTeam','signTitle','signName','signMobile','signEmail'].forEach(id=>$(id).addEventListener('input',()=>{signMsg('');signRedraw()}));
  Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>$(id).addEventListener('input',()=>{if(signEditId){signRedraw();return}const o={};Object.entries(SIGN_FIXED_IDS).forEach(([kk,ii])=>o[kk]=$(ii).value.trim());try{localStorage.setItem(signFixKey(signCompanyNow()),JSON.stringify(o))}catch(e){}signRedraw()}));
  $('signResetFixed').onclick=()=>{const co=signCompanyNow();try{localStorage.removeItem(signFixKey(co))}catch(e){}Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>{$(id).value=SIGN_COMPANIES[co].fixed[k]});signRedraw()};
  $('signCompany').onchange=()=>{const fx=signFixed();Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>{$(id).value=fx[k]});$('signEmail').placeholder=SIGN_COMPANIES[signCompanyNow()].email;signMsg('');signRedraw()};
  $('signEmp').onchange=e=>{const emp=employees.find(x=>String(x.id)===e.target.value);if(emp){$('signName').value=emp.name||'';$('signMobile').value=emp.phone||''}signRedraw()};
  $('signClearBtn').onclick=()=>{signEditId=null;const fx0=signFixed();Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>{$(id).value=fx0[k]});signRenderSaved();['signTeam','signTitle','signName','signMobile','signEmail'].forEach(id=>$(id).value='');$('signEmp').value='';signMsg('');signRedraw()};
  $('signSaveBtn').onclick=()=>{
    if(!($('signName').value||'').trim()){signMsg('이름을 먼저 넣어 주세요.');$('signName').focus();return}
    signRedraw();$('signCanvas').toBlob(b=>{if(!b){signMsg('사진을 만들지 못했습니다.');return}
      const u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=signFileName();document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);
      signMsg(`${signFileName()} 저장했습니다. 휴대폰은 '다운로드' 폴더를 보세요.`);signKeep(true)},'image/png');
  };
  $('signKeepBtn').onclick=()=>{if(!($('signName').value||'').trim()){signMsg('이름을 먼저 넣어 주세요.');$('signName').focus();return}signKeep(false)};
  $('signSavedSearch').oninput=signRenderSaved;
  $('signSavedList').onclick=async ev=>{const b=ev.target.closest('button[data-sact]');if(!b)return;const r=signSaved.find(x=>String(x.id)===b.dataset.id);if(!r)return;
    if(b.dataset.sact==='load'){signLoad(r);window.scrollTo({top:0,behavior:'smooth'});signMsg(`${r.name} 서명을 불러왔습니다. 고친 뒤 저장하면 이 서명이 바뀝니다.`)}
    else if(b.dataset.sact==='png'){const cv=document.createElement('canvas');drawSignCard(cv,{...signFixed(r.company),...signRowData(r)});cv.toBlob(bl=>{const u=URL.createObjectURL(bl),a=document.createElement('a');a.href=u;a.download=`서명_${String(r.name||'카드').replace(/[\\/:*?"<>|\s]+/g,'')}.png`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)},'image/png')}
    else if(b.dataset.sact==='del'){if(!confirm(`${r.name} 서명을 목록에서 지울까요?`))return;const {error}=await sb.from('erp_signatures').delete().eq('id',r.id);if(error){signMsg('지우지 못했습니다: '+error.message);return}if(signEditId===r.id)signEditId=null;signSaved=signSaved.filter(x=>x.id!==r.id);signRenderSaved()}};
  $('signCopyBtn').onclick=async()=>{
    try{signRedraw();const b=await new Promise(r=>$('signCanvas').toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':b})]);signMsg('복사했습니다. 메일 서명 칸에 붙여넣기(Ctrl+V) 하세요.')}
    catch(e){signMsg('이 기기에서는 복사가 안 됩니다. 사진(PNG)으로 저장해서 쓰세요.')}
  };
}
function renderSignView(){
  if(currentTab!=='서명')return;
  showErpView('signView');show($('addBtn'),false);
  bindSignView();signFillEmployees();
  Object.entries(SIGN_COMPANIES).forEach(([k,co])=>{if(signLogos[k])return;const im=new Image();im.onload=()=>{signLogos[k]=im;signRedraw();signRenderSaved()};im.src=co.logo;signLogos[k]=null});
  signRedraw();
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(signRedraw);
  signLoadSaved();
}
// v035: 만든 서명 목록 (DB erp_signatures). 표가 없으면 안내만 보여 주고 사진 저장은 그대로 됨.
const SIGN_COLS='id,team,title,name,mobile,email,updated_at';
function signFixedNow(){const o={};Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>o[k]=($(id)?.value||'').trim());return o}
function signRowData(r){const o={company:signCo(r.company),team:r.team||'',title:r.title||'',name:r.name||'',mobile:r.mobile||'',email:r.email||''};['tel','fax','office','factory'].forEach(k=>{if(r[k])o[k]=r[k]});return o} // v037: 사람별 전화·팩스·주소가 있으면 그 값, 없으면 회사 공통
function signLoad(r){$('signCompany').value=signCo(r.company);$('signEmail').placeholder=SIGN_COMPANIES[signCo(r.company)].email;$('signTeam').value=r.team||'';$('signTitle').value=r.title||'';$('signName').value=r.name||'';$('signMobile').value=r.mobile||'';$('signEmail').value=r.email||'';$('signEmp').value='';const fx=signFixed(r.company);Object.entries(SIGN_FIXED_IDS).forEach(([k,id])=>{$(id).value=r[k]||fx[k]});signEditId=r.id;signRedraw()}
async function signLoadSaved(){
  if(!sb)return;
  let {data,error}=await sb.from('erp_signatures').select(SIGN_COLS+',tel,fax,office,factory,company').order('name');
  signHasCompany=!error;signHasAddr=!error;
  if(error){({data,error}=await sb.from('erp_signatures').select(SIGN_COLS+',tel,fax,office,factory').order('name'));signHasAddr=!error} // v041 SQL 전이면 회사 칸 없이
  if(error)({data,error}=await sb.from('erp_signatures').select(SIGN_COLS).order('name')); // v037 SQL 전이면 주소 칸 없이
  if(error){signSavedReady=false;signSaved=[]}else{signSavedReady=true;signSaved=data||[]}
  signRenderSaved();
}
function signRenderSaved(){
  const box=$('signSavedList');if(!box)return;
  show($('signSavedNotice'),signSavedReady===false);
  const q=($('signSavedSearch')?.value||'').trim().toLowerCase();
  const list=signSaved.filter(r=>!q||[r.name,r.team,r.title,r.mobile,r.email,SIGN_COMPANIES[signCo(r.company)].label].some(v=>String(v||'').toLowerCase().includes(q)));
  $('signSavedCount').textContent=signSavedReady?`${signSaved.length}개`:'';
  if(!signSavedReady){box.innerHTML='';return}
  if(!list.length){box.innerHTML=`<div class="sign-empty">${signSaved.length?'찾는 서명이 없습니다.':'아직 저장한 서명이 없습니다. 위에서 만들고 저장하면 여기에 쌓입니다.'}</div>`;return}
  box.innerHTML=list.map(r=>`<div class="sign-item${signEditId===r.id?' on':''}"><canvas data-sid="${esc(r.id)}"></canvas><div class="sign-item-info"><b>${esc(r.name)} <span class="sign-co sign-co-${signCo(r.company)==='시온'?'z':'c'}">${esc(SIGN_COMPANIES[signCo(r.company)].label)}</span></b><span>${esc([r.team,r.title].filter(Boolean).join(' / ')||'-')}</span><span>${esc(r.mobile||'')}${r.email?' · '+esc(r.email):''}</span></div><div class="sign-item-btns"><button type="button" class="ghost" data-sact="load" data-id="${esc(r.id)}">불러오기</button><button type="button" class="ghost" data-sact="png" data-id="${esc(r.id)}">사진 저장</button><button type="button" class="danger-outline" data-sact="del" data-id="${esc(r.id)}">삭제</button></div></div>`).join('');
  box.querySelectorAll('canvas[data-sid]').forEach(cv=>{const r=list.find(x=>String(x.id)===cv.dataset.sid);if(r)drawSignCard(cv,{...signFixed(r.company),...signRowData(r)})});
}
async function signKeep(quiet){
  if(signSavedReady===false){if(!quiet)signMsg('저장 목록은 v035 SQL을 실행한 뒤에 쓸 수 있습니다.');return}
  const d=signData(),row={team:d.team||null,title:d.title||null,name:d.name,mobile:d.mobile||null,email:d.email||null};
  if(signHasAddr)['tel','fax','office','factory'].forEach(k=>row[k]=d[k]||null);
  if(signHasCompany)row.company=d.company;
  else if(d.company!=='가나안'){signMsg('시온산업 서명을 목록에 저장하려면 v041 SQL을 먼저 실행해 주세요. 사진 저장은 됩니다.');return}
  let id=signEditId;
  if(!id){const same=signSaved.find(r=>r.name===row.name&&String(r.mobile||'')===String(row.mobile||'')&&signCo(r.company)===d.company);if(same)id=same.id}
  const q=id?sb.from('erp_signatures').update(row).eq('id',id):sb.from('erp_signatures').insert(row);
  const {data,error}=await q.select(signHasCompany?SIGN_COLS+',tel,fax,office,factory,company':signHasAddr?SIGN_COLS+',tel,fax,office,factory':SIGN_COLS).single();
  if(error){signMsg((quiet?'사진은 저장했지만 목록에는 못 넣었습니다: ':'목록에 저장하지 못했습니다: ')+error.message);return}
  signSaved=signSaved.filter(r=>r.id!==data.id).concat(data).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  signEditId=data.id;signRenderSaved();
  if(!quiet)signMsg(`${data.name} 서명을 아래 목록에 ${id?'고쳐 ':''}저장했습니다.`);else signMsg(`${signFileName()} 저장했고, 아래 목록에도 넣었습니다.`);
}

})();
