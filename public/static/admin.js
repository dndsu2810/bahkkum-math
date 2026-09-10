(function(){

var PW_TOKEN=''
var students=[]
var allFines=[]
var allQueues=[]
var allRequests=[]
var allOrders=[]
var menuCfg={learn:[],fine:[],shop:[]}
var curCfg={unit:'포인트',symbol:'P',desc:''}
var shopMaxPerOrder=0

function emptyHtml(msg){
  var d=document.createElement('div')
  d.style.cssText='color:var(--g400);text-align:center;padding:20px;'
  d.textContent=msg
  return d.outerHTML
}
function emptyHtmlSm(msg){
  var d=document.createElement('div')
  d.style.cssText='color:var(--g400);font-size:13px;padding:8px 0;'
  d.textContent=msg
  return d.outerHTML
}

var curNoteReqId=null
var queueFilter='all'
var reqFilter='all'
var fineFilter='all'

var DEFAULT_MENU={
  learn:[],
  fine:[
    {id:'helpme',icon:'help',label:'지현쌤 Help me!',cost:3,reward:0,unit:'P',requirePhoto:false},
    {id:'lostwork',icon:'lostwork',label:'숙제 분실',cost:4,reward:0,unit:'P',requirePhoto:false},
    {id:'nohomework',icon:'nohomework',label:'숙제 안함',cost:5,reward:0,unit:'P',requirePhoto:false},
  ],
  shop:[
    {id:'choco',icon:'choco',label:'초콜릿(달달구리)',cost:3,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
    {id:'jelly',icon:'jelly',label:'젤리',cost:2,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
    {id:'candy',icon:'candy',label:'사탕',cost:2,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
    {id:'snack',icon:'snack',label:'과자',cost:3,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
    {id:'saekkomdal',icon:'saekkomdal',label:'새콤달콤',cost:2,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
    {id:'vitaminc',icon:'vitaminc',label:'비타민C',cost:2,reward:0,unit:'P',requirePhoto:false,dailyLimit:0,monthlyStock:0},
  ]
}

// ── 로그인 ──
function doLogin(){
  var pw=document.getElementById('pwInp').value.trim()
  if(!pw)return
  fetch('/api/admin/auth',{headers:{'X-Admin-Password':pw}})
    .then(r=>r.json()).then(d=>{
      if(d.success){
        PW_TOKEN=pw
        document.getElementById('login-screen').classList.add('hidden')
        document.getElementById('main-screen').classList.remove('hidden')
        initAdmin()
      } else {
        document.getElementById('loginErr').classList.add('show')
      }
    }).catch(()=>{document.getElementById('loginErr').classList.add('show')})
}
window.doLogin=doLogin

function doLogout(){PW_TOKEN='';location.reload()}
window.doLogout=doLogout

function api(path,opts){
  opts=opts||{}
  opts.headers=Object.assign({'X-Admin-Password':PW_TOKEN,'Content-Type':'application/json'},opts.headers||{})
  return fetch(path,opts).then(r=>r.json())
}

// ── 탭 전환 ──
function switchMainTab(tab){
  document.querySelectorAll('.mtab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+tab))
  if(tab==='queue')loadQueue()
  else if(tab==='orders')loadOrders()
  else if(tab==='students')renderStudents()
  else if(tab==='menu')renderMenuItems('shop')
  else if(tab==='loans')loadLoans()
}
window.switchMainTab=switchMainTab

// ── 초기화 ──
function initAdmin(){
  document.getElementById('queueDatePick').value=new Date().toISOString().slice(0,10)
  loadConfig()
  loadStudentsData()
  loadQueue()
  loadOrders()
  loadLoans()
}

function loadConfig(){
  fetch('/api/config').then(function(r){return r.json()}).then(function(cfg){
    menuCfg=cfg.menu||JSON.parse(JSON.stringify(DEFAULT_MENU))
    curCfg={unit:'포인트',symbol:'star',desc:'포인트를 모아 간식과 바꿔요'}
    shopMaxPerOrder=+(cfg.shopMaxPerOrder)||0
    var mpo=document.getElementById('shopMaxPerOrder')
    if(mpo)mpo.value=shopMaxPerOrder
    renderMenuItems('shop')
  }).catch(function(){
    menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))
  })
}

function saveConfigToServer(callback){
  var cfg={currency:curCfg,menu:menuCfg,shopMaxPerOrder:shopMaxPerOrder}
  api('/api/admin/config',{method:'POST',body:JSON.stringify(cfg)}).then(function(d){
    if(d.success){
      if(callback)callback()
    } else {
      toast('저장 실패: '+(d.error||''))
    }
  }).catch(function(){ toast('저장 중 오류 발생') })
}

function loadStudentsData(){
  fetch('/api/students').then(r=>r.json()).then(d=>{
    if(d.success){
      students=d.students
      renderStudents()
    }
  })
}

// ══ 번호표 ══
function loadQueue(){
  var date=document.getElementById('queueDatePick').value||new Date().toISOString().slice(0,10)
  api('/api/admin/queue?date='+date).then(function(d){
    if(!d.success)return
    allQueues=d.tickets
    var w=allQueues.filter(function(t){return t.status==='waiting'}).length
    var a=allQueues.filter(function(t){return t.status==='answering'}).length
    var dn=allQueues.filter(function(t){return t.status==='done'}).length
    document.getElementById('qs-waiting').textContent=w
    document.getElementById('qs-answering').textContent=a
    document.getElementById('qs-done').textContent=dn
    document.getElementById('qs-total').textContent=allQueues.length
    document.getElementById('badge-queue').textContent=(w+a)>0?(w+a):''
    renderQueueList()
  })
}
window.loadQueue=loadQueue

function renderQueueList(){
  var list=allQueues.filter(function(t){return queueFilter==='all'||t.status===queueFilter})
  var el=document.getElementById('queueList')
  if(list.length===0){el.innerHTML=emptyHtml('항목 없음');return}
  el.innerHTML=list.map(function(t){
    var sc=t.status==='done'?'done':t.status==='answering'?'answering':'waiting'
    var sl=t.status==='done'?'완료':t.status==='answering'?'답변중':'대기'
    var tm=t.created_at?t.created_at.slice(11,16):''
    return '<div class="ticket-item">'+
      '<div class="ticket-num '+sc+'">'+t.number+'</div>'+
      '<div class="ticket-info">'+
        '<div class="ticket-name">'+esc(t.student_name)+'</div>'+
        '<div class="ticket-time">'+tm+' 발급</div>'+
      '</div>'+
      '<span class="ticket-status-badge '+sc+'">'+sl+'</span>'+
      '<div class="ticket-actions">'+
        (t.status!=='done'?'<button class="btn btn-sm" style="background:var(--yellow-s);color:#92400e;border:1.5px solid #fcd34d;" data-qid="'+t.id+'" data-qst="answering" data-qaction="status"><i class="fas fa-bullhorn"></i> '+(t.status==='answering'?'다시 호출':'호출')+'</button>':'')+
        (t.status!=='done'?'<button class="btn btn-green btn-sm" data-qid="'+t.id+'" data-qst="done" data-qaction="status"><i class="fas fa-check"></i> 완료</button>':'')+
        (t.status==='done'?'<button class="btn btn-gray btn-sm" data-qid="'+t.id+'" data-qst="waiting" data-qaction="status"><i class="fas fa-rotate-left"></i> 되돌리기</button>':'')+
      '</div>'+
    '</div>'
  }).join('')
}

window.setQueueStatus=function(id,status){
  api('/api/admin/queue/'+id+'/status',{method:'POST',body:JSON.stringify({status:status})}).then(function(d){
    if(d.success){toast(status==='answering'?'📢 호출 방송했어요':'상태 변경 완료');loadQueue()}
    else toast('오류: '+d.error)
  })
}

// 관리자 브라우저에서 바로 음성 출력 (ko-KR)
var _admVoices=[], _admPrimed=false
function admLoadVoices(){ try{_admVoices=window.speechSynthesis.getVoices()||[]}catch(e){} }
if('speechSynthesis' in window){ try{window.speechSynthesis.onvoiceschanged=admLoadVoices}catch(e){} admLoadVoices() }
// 오디오 잠금 해제(첫 사용자 제스처에서 무음 발화)
function admPrime(){
  if(_admPrimed||!('speechSynthesis' in window))return
  try{ var u=new SpeechSynthesisUtterance(' ');u.volume=0;window.speechSynthesis.speak(u);_admPrimed=true;admLoadVoices() }catch(e){}
}
document.addEventListener('click',admPrime,{passive:true})
document.addEventListener('keydown',admPrime,{passive:true})
// ── 관리자 음성: 실제 MP3 재생(안정적) + speechSynthesis 폴백 ──
// 서버 /api/tts 가 한국어 텍스트를 MP3로 내려줌 → speechSynthesis 의 "몇 번 후 멈춤" 버그 없음
var _ttsAudio=null, _ttsQueue=[]
function ttsChunks(text){
  text=String(text).replace(/\s*\n\s*/g,'. ').replace(/\s+/g,' ').trim()
  var out=[], max=170
  while(text.length>max){
    var cut=text.lastIndexOf(' ',max); if(cut<40)cut=max
    out.push(text.slice(0,cut).trim()); text=text.slice(cut).trim()
  }
  if(text)out.push(text)
  return out
}
function ttsNext(){
  if(!_ttsQueue.length)return
  var t=_ttsQueue.shift()
  if(!_ttsAudio)_ttsAudio=new Audio()
  _ttsAudio.onended=ttsNext
  _ttsAudio.onerror=function(){ _ttsQueue=[]; speakSynth(t) }   // MP3 실패 → 브라우저 음성 폴백
  _ttsAudio.src='/api/tts?text='+encodeURIComponent(t)
  var p=_ttsAudio.play()
  if(p&&p.catch)p.catch(function(){ _ttsQueue=[]; speakSynth(t) })
}
function speakLocal(text){
  if(!text)return
  try{ if(_ttsAudio){ _ttsAudio.pause() } }catch(e){}
  _ttsQueue=ttsChunks(text)
  ttsNext()
}
// speechSynthesis 폴백 (서버 TTS가 안 될 때만)
if('speechSynthesis' in window){
  setInterval(function(){ try{ var s=window.speechSynthesis; if(s.paused) s.resume() }catch(e){} }, 5000)
}
function speakSynth(text){
  if(!('speechSynthesis' in window)||!text)return
  try{
    var synth=window.speechSynthesis
    if(!_admVoices.length)admLoadVoices()
    try{ synth.cancel() }catch(e){}
    try{ synth.resume() }catch(e){}
    setTimeout(function(){
      try{
        var u=new SpeechSynthesisUtterance(String(text))
        u.lang='ko-KR';u.rate=0.98;u.pitch=1;u.volume=1
        for(var i=0;i<_admVoices.length;i++){if(/ko/i.test(_admVoices[i].lang)){u.voice=_admVoices[i];break}}
        synth.speak(u)
      }catch(e){}
    }, 90)
  }catch(e){}
}
window.testVoice=function(){ speakLocal('소리 테스트. 잘 들리나요?') }

// 키오스크 칠판에 쓰기 (관리자 기기에서 음성 + 키오스크 화면 표시)
window.sendAnnounce=function(){
  var el=document.getElementById('announceText'); var t=(el&&el.value||'').trim()
  if(!t){toast('문구를 입력하세요');return}
  speakLocal(t)   // 관리자에서 바로 음성
  api('/api/admin/announce',{method:'POST',body:JSON.stringify({text:t,kind:'board'})}).then(function(d){
    if(d.success){toast('🖍️ 칠판에 썼어요');el.value=''}
    else toast('오류: '+(d.error||''))
  })
}
// 키오스크 칠판 지우기
window.clearBoard=function(){
  api('/api/admin/announce',{method:'POST',body:JSON.stringify({kind:'clear'})}).then(function(d){
    if(d.success){toast('🧽 칠판을 지웠어요')}
    else toast('오류: '+(d.error||''))
  })
}

// ── 전체화면 칠판 모드 ──
window.openBoardMode=function(){
  var bm=document.getElementById('boardMode'); if(!bm)return
  admPrime()   // 오디오 잠금 해제 (버튼 클릭 = 사용자 제스처)
  bm.style.display='flex'
  var ta=document.getElementById('boardInput')
  if(ta) setTimeout(function(){ta.focus()},60)
}
window.closeBoardMode=function(){
  var bm=document.getElementById('boardMode'); if(bm)bm.style.display='none'
}
function commitBoard(){
  var ta=document.getElementById('boardInput'); if(!ta)return
  var t=(ta.value||'').trim()
  if(!t){toast('내용을 입력하세요');return}
  speakLocal(t)   // 관리자 기기에서 바로 음성
  api('/api/admin/announce',{method:'POST',body:JSON.stringify({text:t,kind:'board'})}).then(function(d){
    if(!d.success)toast('오류: '+(d.error||''))
  })
}
// Enter=전송(음성), Alt+Enter=줄바꿈, Esc=닫기
;(function(){
  var ta=document.getElementById('boardInput'); if(!ta)return
  ta.addEventListener('keydown',function(e){
    if(e.key==='Enter'){
      if(e.altKey){
        e.preventDefault()
        var s=ta.selectionStart,en=ta.selectionEnd,v=ta.value
        ta.value=v.slice(0,s)+'\n'+v.slice(en)
        ta.selectionStart=ta.selectionEnd=s+1
      } else if(!e.shiftKey){
        e.preventDefault()
        commitBoard()
      }
    } else if(e.key==='Escape'){
      closeBoardMode()
    }
  })
})()

function filterQueue(f,el){
  queueFilter=f
  document.querySelectorAll('#tab-queue .filter-btn').forEach(function(b){b.classList.remove('active')})
  el.classList.add('active')
  renderQueueList()
}
window.filterQueue=filterQueue

// ══ 주문현황 ══
function loadOrders(){
  var stu=document.getElementById('orderSearch').value.trim()
  var cat=document.getElementById('orderCatFilter').value
  var qs='?student='+encodeURIComponent(stu)+'&category='+cat
  api('/api/admin/orders'+qs).then(function(d){
    if(!d.success)return
    allOrders=d.orders
    renderOrderList()
  })
}
window.loadOrders=loadOrders

function renderOrderList(){
  var el=document.getElementById('orderList')
  if(allOrders.length===0){el.innerHTML=emptyHtml('항목 없음');return}
  var catEmoji={learn:'학습',fine:'벌점',shop:'상점'}
  el.innerHTML=allOrders.map(function(o){
    var items=[]
    try{items=JSON.parse(o.items_json)}catch(e){}
    var itemsTxt=items.map(function(x){return x.label+(x.qty>1?' x'+x.qty:'')}).join(' / ')
    var costVal=o.total_cost
    var cc=costVal===0?'free':costVal<0?'gain':'loss'
    var ct=costVal===0?'무료':costVal<0?'+'+Math.abs(costVal)+' '+o.currency+' 획득':'-'+costVal+' '+o.currency+' 차감'
    var tm=o.created_at?o.created_at.slice(0,16).replace('T',' '):''
    return '<div class="order-item">'+
      '<div class="order-cat '+o.category+'">'+(catEmoji[o.category]||'기타')+'</div>'+
      '<div class="order-body">'+
        '<div class="order-top">'+
          '<span class="order-stu">'+esc(o.student_name)+'</span>'+
          '<span class="order-time">'+tm+'</span>'+
          (o.has_photo?'<span style="font-size:10px;background:var(--orange);color:white;padding:2px 6px;border-radius:100px;font-weight:800;">사진</span>':'')+
        '</div>'+
        '<div class="order-items-txt">'+esc(itemsTxt)+'</div>'+
        (o.comment?'<div style="font-size:11px;color:var(--indigo);margin-top:2px;">'+esc(o.comment)+'</div>':'')+
      '</div>'+
      '<div class="order-cost '+cc+'">'+ct+'</div>'+
    '</div>'
  }).join('')
}

// ══ 포인트 교환 대출 ══
var allLoans=[]
function loadLoans(){
  api('/api/admin/loans').then(function(d){
    if(!d.success)return
    allLoans=d.loans||[]
    renderLoans()
    updateLoanBadge()
  })
}
window.loadLoans=loadLoans

function updateLoanBadge(){
  var open=allLoans.filter(function(l){return !l.repaid_at}).length
  var b=document.getElementById('badge-loans')
  if(!b)return
  if(open>0){b.textContent=open;b.style.display=''}else{b.style.display='none'}
}

function renderLoans(){
  var el=document.getElementById('loanList')
  if(!allLoans.length){el.innerHTML=emptyHtml('대출 내역 없음');return}
  el.innerHTML=allLoans.map(function(l){
    var open=!l.repaid_at
    var tm=l.created_at?String(l.created_at).slice(0,16).replace('T',' '):''
    var rtm=l.repaid_at?String(l.repaid_at).slice(0,16).replace('T',' '):''
    return '<div class="order-item">'+
      '<div class="order-cat '+(open?'fine':'learn')+'">'+(open?'미상환':'상환')+'</div>'+
      '<div class="order-body">'+
        '<div class="order-top">'+
          '<span class="order-stu">'+esc(l.student_name)+'</span>'+
          '<span class="order-time">'+tm+'</span>'+
        '</div>'+
        '<div class="order-items-txt">'+l.points+' 포인트 대출 · 당일 보충 '+l.minutes+'분'+(rtm?' · 상환 '+rtm:'')+'</div>'+
      '</div>'+
      (open
        ? '<button class="btn btn-green btn-sm" onclick="repayLoan('+l.id+')"><i class="fas fa-check"></i> 상환</button>'
        : '<div class="order-cost gain">완료</div>')+
    '</div>'
  }).join('')
}

function repayLoan(id){
  if(!confirm('이 대출을 상환 처리할까요? (보충수업 완료 확인)'))return
  api('/api/admin/loans/'+id+'/repay',{method:'POST'}).then(function(d){
    if(d&&d.success){loadLoans()}else{alert('상환 처리 실패')}
  })
}
window.repayLoan=repayLoan

// ══ 학생 관리 ══
function renderStudents(){
  var el=document.getElementById('stuList')
  if(students.length===0){el.innerHTML=emptyHtml('학생이 없습니다.');return}
  el.innerHTML=students.map(function(s){
    var av=s.photo_url
      ?'<img class="stu-av-sm" src="'+esc(s.photo_url)+'" alt=""/>'
      :'<div class="stu-av-txt">'+esc(s.name[0])+'</div>'
    return '<div class="stu-list-item" style="flex-wrap:wrap;">'+av+
      '<div class="stu-name-lbl">'+esc(s.name)+'</div>'+
      '<span class="stu-pts-lbl">'+s.points+'P</span>'+
      '<div style="display:flex;gap:4px;margin-left:auto;">'+
      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="hist"><i class="fas fa-clock-rotate-left"></i></button>'+
      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="adj"><i class="fas fa-plus-minus"></i></button>'+
      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-saction="photo"><i class="fas fa-camera"></i></button>'+
      '<button class="btn btn-blue btn-sm btn-icon" title="수업 시간표" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="schedule"><i class="fas fa-calendar-week"></i></button>'+
      '<button class="btn btn-red btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="del"><i class="fas fa-trash"></i></button>'+
      '</div>'+
    '</div>'
  }).join('')
}

window.addStudent=function(){
  var name=document.getElementById('newStuName').value.trim()
  if(!name){toast('이름 입력');return}
  api('/api/admin/students',{method:'POST',body:JSON.stringify({name:name})}).then(function(d){
    if(d.success){document.getElementById('newStuName').value='';toast('추가: '+name);loadStudentsData()}
    else toast('오류: '+d.error)
  })
}

window.delStudent=function(id,name){
  if(!confirm(name+' 삭제?'))return
  api('/api/admin/students/'+id,{method:'DELETE'}).then(function(d){
    if(d.success){toast('삭제됨');loadStudentsData()}
  })
}

window.adjPoints=function(id,name){
  var v=prompt(name+'님 포인트 조정 (예: +5 또는 -3)','')
  if(!v)return
  var delta=parseInt(v)
  if(isNaN(delta)){toast('숫자로 입력하세요');return}
  api('/api/admin/students/'+id+'/points',{method:'POST',body:JSON.stringify({delta:delta,reason:'관리자 조정'})}).then(function(d){
    if(d.success){toast('조정 완료');loadStudentsData()}
  })
}

window.uploadPhoto=function(id){
  var inp=document.createElement('input');inp.type='file';inp.accept='image/*'
  inp.onchange=function(){
    var f=inp.files[0];if(!f)return
    var r=new FileReader()
    r.onload=function(ev){
      api('/api/admin/students/'+id+'/photo',{method:'POST',body:JSON.stringify({photoBase64:ev.target.result})}).then(function(d){
        if(d.success){toast('사진 업데이트');loadStudentsData()}
      })
    };r.readAsDataURL(f)
  };inp.click()
}

window.showHist=function(id,name){
  fetch('/api/students/'+id).then(r=>r.json()).then(d=>{
    if(!d.success)return
    document.getElementById('histTitle').textContent=name+' 포인트 이력'
    var hist=d.history||[]
    document.getElementById('histList').innerHTML=hist.length===0
      ?'<div style="color:var(--g400)">이력 없음</div>'
      :hist.map(function(h){
        var pos=h.delta>=0
        return '<div class="hist-item"><span>'+esc(h.reason||'')+'</span><span class="hist-delta '+(pos?'pos':'neg')+'">'+(pos?'+':'')+h.delta+'</span></div>'
      }).join('')
    document.getElementById('hist-modal').classList.add('open')
  })
}

// ══ 메뉴 설정 ══
function renderMenuItems(type){
  var el=document.getElementById('menu'+type.charAt(0).toUpperCase()+type.slice(1)+'List')
  var items=menuCfg[type]||[]
  if(items.length===0){el.innerHTML=emptyHtmlSm('항목 없음');return}
  el.innerHTML=items.map(function(m,i){
    var isLearn=type==='learn'
    var isFine=type==='fine'
    var isShop=type==='shop'
    var valField=isLearn
      ?'<input class="item-cost-inp" type="number" value="'+(m.reward||0)+'" onchange="menuCfg.'+type+'['+i+'].reward=+this.value" placeholder="보상"/>'
      :'<input class="item-cost-inp" type="number" value="'+(m.cost||0)+'" onchange="menuCfg.'+type+'['+i+'].cost=+this.value" placeholder="비용"/>'
    var fineTypeField=isFine
      ?'<select class="item-unit-sel" onchange="menuCfg.fine['+i+'].fineType=this.value;menuCfg.fine['+i+'].unit=(this.value===\'time\'?\'분\':this.value===\'sheet\'?\'장\':curCfg.unit);renderMenuItems(\'fine\')" style="width:70px;font-size:12px;">'+
        '<option value="point"'+(((m.fineType||'point')==='point')?' selected':'')+'>포인트</option>'+
        '<option value="time"'+((m.fineType==='time')?' selected':'')+'>시간(분)</option>'+
        '<option value="sheet"'+((m.fineType==='sheet')?' selected':'')+'>학습지(장)</option>'+
      '</select>'
      :''
    var soldOutField=isShop
      ?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;"><input type="checkbox" class="shop-soldout-cb" '+(m.soldOut?'checked':'')+' onchange="menuCfg.shop['+i+'].soldOut=this.checked;renderMenuItems(\'shop\')"/> 품절</label>'
      :''
    var hiddenField=isShop
      ?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;color:'+(m.hidden?'#b91c1c':'inherit')+';"><input type="checkbox" class="shop-hidden-cb" '+(m.hidden?'checked':'')+' onchange="menuCfg.shop['+i+'].hidden=this.checked;renderMenuItems(\'shop\')"/> 숨김</label>'
      :''
    // 상점 전용: 하루 한도 + 월별 재고
    var stockFields=isShop
      ?'<div style="display:flex;flex-direction:column;gap:2px;">'+
          '<input class="item-cost-inp shop-daily-limit" type="number" value="'+(m.dailyLimit||0)+'" min="0" title="하루 구매 한도 (0=무제한)" placeholder="일한도" style="width:56px;font-size:11px;" data-idx="'+i+'"/>'+
          '<span style="font-size:9px;color:var(--g400);text-align:center;">일한도</span>'+
        '</div>'+
        '<div style="display:flex;flex-direction:column;gap:2px;">'+
          '<input class="item-cost-inp shop-monthly-stock" type="number" value="'+(m.monthlyStock||0)+'" min="0" title="월 재고 (0=무제한)" placeholder="월재고" style="width:56px;font-size:11px;" data-idx="'+i+'"/>'+
          '<span style="font-size:9px;color:var(--g400);text-align:center;">월재고</span>'+
        '</div>'
      :''
    return '<div class="menu-item-row"'+(isShop&&m.hidden?' style="opacity:.55;"':'')+'>'+
      '<div class="item-label">'+esc(m.label)+(isShop&&m.hidden?' <span style="font-size:10px;color:#b91c1c;font-weight:800;">(숨김)</span>':'')+'</div>'+
      valField+
      (isFine?fineTypeField:'')+
      (isLearn?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;"><input type="checkbox" '+(m.requirePhoto?'checked':'')+' onchange="menuCfg.'+type+'['+i+'].requirePhoto=this.checked"/> 사진</label>':'')+
      soldOutField+
      hiddenField+
      stockFields+
      '<button class="item-del-btn" data-mtype="'+type+'" data-midx="'+i+'" data-maction="del"><i class="fas fa-trash"></i></button>'+
    '</div>'
  }).join('')
}

window.delMenuItem=function(type,i){
  menuCfg[type].splice(i,1)
  renderMenuItems(type)
}

function addMenuItem(type){
  var pfx={learn:'nL',fine:'nF',shop:'nS'}[type]
  var ic=(type==='shop'?'snack':type==='fine'?'nohomework':'study')
  var lbl=document.getElementById(pfx+'Lbl').value.trim()
  if(!lbl){toast('항목 이름 입력');return}
  var costEl=document.getElementById(type==='learn'?'nLRew':type==='fine'?'nFCost':'nSCost')
  var cost=parseInt(costEl.value||'0')||0
  var unit=curCfg.unit||'포인트'
  var newId=type+'_'+Date.now()
  {
    // 상점: 하루 한도, 월 재고 포함
    var dlEl=document.getElementById('nSDailyLimit')
    var msEl=document.getElementById('nSMonthlyStock')
    menuCfg[type].push({
      id:newId,icon:ic,label:lbl,cost:cost,reward:0,unit:unit,
      requirePhoto:false,soldOut:false,hidden:false,
      dailyLimit:+(dlEl&&dlEl.value)||0,
      monthlyStock:+(msEl&&msEl.value)||0
    })
  }
  document.getElementById(pfx+'Lbl').value=''
  costEl.value=''
  renderMenuItems(type);toast('추가: '+lbl)
}

document.getElementById('addShopBtn').addEventListener('click',function(){addMenuItem('shop')})

document.getElementById('savemenuBtn').addEventListener('click',function(){
  ;['shop'].forEach(function(t){
    var el=document.getElementById('menu'+t.charAt(0).toUpperCase()+t.slice(1)+'List')
    if(!el)return
    var rows=el.querySelectorAll('.menu-item-row')
    rows.forEach(function(row,i){
      if(!menuCfg[t][i])return
      var costInp=row.querySelector('.item-cost-inp:not(.shop-daily-limit):not(.shop-monthly-stock)')
      if(costInp){
        if(t==='learn') menuCfg[t][i].reward=+(costInp.value)||0
        else menuCfg[t][i].cost=+(costInp.value)||0
      }
      if(t==='shop'){
        var scb=row.querySelector('.shop-soldout-cb')
        if(scb) menuCfg[t][i].soldOut=scb.checked
        var hcb=row.querySelector('.shop-hidden-cb')
        if(hcb) menuCfg[t][i].hidden=hcb.checked
        // 하루 한도 / 월 재고 수집
        var dlInp=row.querySelector('.shop-daily-limit')
        var msInp=row.querySelector('.shop-monthly-stock')
        if(dlInp) menuCfg[t][i].dailyLimit=+(dlInp.value)||0
        if(msInp) menuCfg[t][i].monthlyStock=+(msInp.value)||0
      }
      if(t==='learn'){
        var pcb=row.querySelector('input[type="checkbox"]')
        if(pcb) menuCfg[t][i].requirePhoto=pcb.checked
      }
    })
  })
  var mpoInp=document.getElementById('shopMaxPerOrder')
  if(mpoInp) shopMaxPerOrder=+(mpoInp.value)||0
  saveConfigToServer(function(){ toast('메뉴 저장 완료! 키오스크에 즉시 반영됩니다.') })
})

document.getElementById('resetmenuBtn').addEventListener('click',function(){
  if(!confirm('기본값으로 초기화? 저장된 설정이 모두 삭제됩니다.'))return
  menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))
  renderMenuItems('shop')
  saveConfigToServer(function(){ toast('기본값으로 초기화됨') })
})


// ── 유틸 ──
function esc(s){var r=String(s);r=r.split('&').join('&amp;');r=r.split('<').join('&lt;');r=r.split('>').join('&gt;');r=r.split(String.fromCharCode(34)).join('&#34;');return r}
function toast(msg){var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},2200)}

document.getElementById('closeHistBtn').addEventListener('click',function(){document.getElementById('hist-modal').classList.remove('open')})

// ── 이벤트 위임 ──
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-qaction]')
  if(btn){
    var id=btn.dataset.qid, st=btn.dataset.qst
    if(btn.dataset.qaction==='status') setQueueStatus(id,st)
    return
  }
  btn=e.target.closest('[data-saction]')
  if(btn){
    var sid=btn.dataset.sid, sname=btn.dataset.sname||''
    if(btn.dataset.saction==='hist') showHist(sid,sname)
    else if(btn.dataset.saction==='adj') adjPoints(sid,sname)
    else if(btn.dataset.saction==='photo') uploadPhoto(sid)
    else if(btn.dataset.saction==='schedule') openStudentSchedule(sid,sname)
    else if(btn.dataset.saction==='del') delStudent(sid,sname)
    return
  }
  btn=e.target.closest('[data-maction]')
  if(btn){
    if(btn.dataset.maction==='del') delMenuItem(btn.dataset.mtype, parseInt(btn.dataset.midx))
    return
  }
  btn=e.target.closest('[data-unlock-id]')
  if(btn){
    var reqId=btn.dataset.unlockId, reqName=btn.dataset.unlockName||''
    openApproveModal(reqId, reqName)
    return
  }
})

// ── 학생별 시간표 모달 ──
var stuSchedId=null, stuSchedSlots=[]
var DAYS=['월','화','수','목','금','토','일']

function openStudentSchedule(sid, sname){
  stuSchedId=sid
  stuSchedSlots=[]
  var modal=document.getElementById('stu-sched-modal')
  if(!modal)return
  document.getElementById('stuSchedTitle').textContent=esc(sname)+' 수업 시간표'
  document.getElementById('stuSchedSlots').innerHTML='<div style="color:var(--g400);text-align:center;padding:12px;">로딩 중...</div>'
  modal.classList.add('open')
  api('/api/admin/students/'+sid+'/schedule').then(function(d){
    stuSchedSlots=d.success&&Array.isArray(d.schedule)?d.schedule:[]
    renderStuSchedSlots()
  }).catch(function(){stuSchedSlots=[];renderStuSchedSlots()})
}

function renderStuSchedSlots(){
  var el=document.getElementById('stuSchedSlots')
  if(!el)return
  if(stuSchedSlots.length===0){
    el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">추가된 시간대가 없습니다.<br><span style="font-size:11px;color:var(--g300);">비워두면 전체 시간표가 적용됩니다.</span></div>'
    return
  }
  var html=''
  stuSchedSlots.forEach(function(sl,i){
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">'
    html+='<select class="ss-day" data-idx="'+i+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    DAYS.forEach(function(d){html+='<option value="'+d+'"'+(sl.day===d?' selected':'')+'>'+d+'</option>'})
    html+='</select>'
    html+='<input type="time" class="ss-start" data-idx="'+i+'" value="'+(sl.start||'')+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<span style="color:var(--g400);">~</span>'
    html+='<input type="time" class="ss-end" data-idx="'+i+'" value="'+(sl.end||'')+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<button class="btn btn-red btn-sm" onclick="removeStuSchedSlot('+i+')"><i class="fas fa-trash"></i></button>'
    html+='</div>'
  })
  el.innerHTML=html
}

window.addStuSchedSlot=function(){
  stuSchedSlots.push({day:'월',start:'14:00',end:'16:00'})
  renderStuSchedSlots()
}
window.removeStuSchedSlot=function(i){
  stuSchedSlots.splice(i,1)
  renderStuSchedSlots()
}
window.saveStuSchedule=function(){
  if(!stuSchedId)return
  var dayEls=document.querySelectorAll('.ss-day')
  var startEls=document.querySelectorAll('.ss-start')
  var endEls=document.querySelectorAll('.ss-end')
  var arr=[]
  dayEls.forEach(function(el,i){arr.push({day:el.value,start:startEls[i].value,end:endEls[i].value})})
  stuSchedSlots=arr
  api('/api/admin/students/'+stuSchedId+'/schedule',{method:'POST',body:JSON.stringify({schedule:stuSchedSlots})}).then(function(d){
    if(d.success){
      toast('시간표 저장됨!')
      document.getElementById('stu-sched-modal').classList.remove('open')
    } else {
      toast('저장 실패: '+(d.error||''))
    }
  })
}
window.closeStuSchedModal=function(){
  document.getElementById('stu-sched-modal').classList.remove('open')
}

// ── 상점 잠금 관련 ──
var shopSchedule=[]

function loadShopRequests(){
  var el=document.getElementById('shopRequestList')
  if(!el)return
  el.innerHTML='<div style="color:var(--g400);text-align:center;padding:16px;">로딩 중...</div>'
  api('/api/admin/shop/requests').then(function(d){
    if(!d.success||!d.requests||d.requests.length===0){
      el.innerHTML='<div style="color:var(--g400);text-align:center;padding:16px;">승인 요청이 없습니다.</div>'
      return
    }
    var html=''
    d.requests.forEach(function(r){
      var statusLabel={pending:'대기',approved:'승인',expired:'만료',rejected:'거절'}[r.status]||r.status
      var statusColor={pending:'#f59e0b',approved:'#22c55e',expired:'#94a3b8',rejected:'#ef4444'}[r.status]||'#94a3b8'
      var dt=r.requested_at?r.requested_at.replace('T',' ').substring(0,16):''
      html+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--g100);">'
      html+='<div style="flex:1;">'
      html+='<div style="font-weight:700;font-size:14px;">'+esc(r.student_name)+'</div>'
      html+='<div style="font-size:12px;color:var(--g400);">'+esc(dt)+'</div>'
      html+='</div>'
      html+='<span style="font-size:12px;font-weight:700;color:'+statusColor+';">'+statusLabel+'</span>'
      if(r.status==='pending'){
        html+='<button class="btn btn-green btn-sm" data-unlock-id="'+r.id+'" data-unlock-name="'+esc(r.student_name)+'"><i class="fas fa-unlock"></i> 열기</button>'
      }
      html+='</div>'
    })
    el.innerHTML=html
  }).catch(function(){
    el.innerHTML='<div style="color:#ef4444;text-align:center;padding:16px;">불러오기 실패</div>'
  })
}

// 상점 상태 표시 (시간표 모드 포함)
function loadShopStatus(){
  var el=document.getElementById('shopStatusBadge')
  var lockBtn=document.getElementById('adminLockBtn')
  var unlockBtn=document.getElementById('adminUnlockBtn')
  if(!el)return
  api('/api/shop/status').then(function(d){
    if(!d.success)return
    if(d.forceLocked){
      el.style.cssText='padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;'
      el.textContent='관리자 강제 잠금 중 – 직접 풀기 전까지 유지'
      if(lockBtn){lockBtn.textContent='잠금 중';lockBtn.disabled=true;lockBtn.style.opacity='0.5'}
      if(unlockBtn){unlockBtn.disabled=false;unlockBtn.style.opacity='1'}
    } else if(d.forceOpen){
      el.style.cssText='padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;background:#f0fdf4;color:#15803d;border:1.5px solid #86efac;'
      el.textContent='완전 오픈 중 – 잠금 전까지 계속 열림'
      if(lockBtn){lockBtn.textContent='즉시 잠금';lockBtn.disabled=false;lockBtn.style.opacity='1'}
      if(unlockBtn){unlockBtn.disabled=true;unlockBtn.style.opacity='0.5'}
    } else if(d.locked){
      el.style.cssText='padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;'
      el.textContent='수업 시간 – 시간표에 따라 자동 잠금 중'
      if(lockBtn){lockBtn.textContent='즉시 잠금';lockBtn.disabled=false;lockBtn.style.opacity='1'}
      if(unlockBtn){unlockBtn.disabled=false;unlockBtn.style.opacity='1'}
    } else if(d.unlocked){
      var exp=d.expiresAt?new Date(d.expiresAt+'Z'):null
      var remain=exp?Math.max(0,Math.ceil((exp-Date.now())/60000)):0
      el.style.cssText='padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;background:#fff7ed;color:#c2410c;border:1.5px solid #fdba74;'
      el.textContent='임시 오픈 중 (약 '+remain+'분 남음)'
      if(lockBtn){lockBtn.textContent='즉시 잠금';lockBtn.disabled=false;lockBtn.style.opacity='1'}
      if(unlockBtn){unlockBtn.disabled=false;unlockBtn.style.opacity='1'}
    } else {
      // 시간표 모드 – 수업 시간이 아닌 경우 자동으로 열림
      el.style.cssText='padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;background:#f0fdf4;color:#16a34a;border:1.5px solid #86efac;'
      el.textContent='시간표 모드 – 지금은 수업 시간이 아니라 상점 열림'
      if(lockBtn){lockBtn.textContent='즉시 잠금';lockBtn.disabled=false;lockBtn.style.opacity='1'}
      if(unlockBtn){unlockBtn.disabled=false;unlockBtn.style.opacity='1'}
    }
  })
}

window.adminUnlockShop=function(){
  openUnlockModal()
}

function openApproveModal(reqId, reqName){
  var existing=document.getElementById('approve-modal')
  if(existing)existing.remove()
  var modal=document.createElement('div')
  modal.id='approve-modal'
  modal.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:16px;'
  modal.innerHTML='<div style="background:#fff;border-radius:16px;padding:24px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.18);">'+
    '<div style="font-size:16px;font-weight:800;margin-bottom:6px;color:#0f172a;">요청 승인</div>'+
    '<div style="font-size:13px;color:#64748b;margin-bottom:12px;"><b>'+esc(reqName)+'</b> 학생의 요청을 승인합니다.<br>몇 분간 상점을 열까요?</div>'+
    '<input id="approveMinsInp" type="number" value="10" min="1" max="180" style="width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;font-weight:700;text-align:center;margin-bottom:14px;box-sizing:border-box;">'+
    '<div style="display:flex;gap:8px;">'+
    '<button onclick="doApproveUnlock(\''+reqId+'\',\''+esc(reqName)+'\')" style="flex:1;padding:10px;background:#22c55e;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">승인</button>'+
    '<button onclick="document.getElementById(\'approve-modal\').remove()" style="padding:10px 16px;background:#f1f5f9;color:#475569;border:none;border-radius:10px;font-size:14px;cursor:pointer;">취소</button>'+
    '</div></div>'
  document.body.appendChild(modal)
  document.getElementById('approveMinsInp').focus()
  document.getElementById('approveMinsInp').select()
}

window.doApproveUnlock=function(reqId,reqName){
  var mins=parseInt(document.getElementById('approveMinsInp').value)||10
  if(mins<=0)mins=10
  document.getElementById('approve-modal').remove()
  api('/api/admin/shop/unlock',{method:'POST',body:JSON.stringify({requestId:reqId,minutes:mins})}).then(function(d){
    if(d.success){toast(reqName+' 요청 승인! '+mins+'분간 상점 열립니다.');loadShopRequests();loadShopStatus()}
    else toast('오류: '+(d.error||''))
  })
}

// 열기 모달 (시간표 모드 탭 포함)
function openUnlockModal(){
  var existing=document.getElementById('unlock-modal')
  if(existing)existing.remove()
  var modal=document.createElement('div')
  modal.id='unlock-modal'
  modal.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;'
  modal.innerHTML=
    '<div style="background:#fff;border-radius:18px;padding:0;max-width:380px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden;">'+
      '<div style="padding:20px 20px 0;font-size:17px;font-weight:800;color:#0f172a;">상점 열기</div>'+
      '<div style="display:flex;gap:0;padding:14px 20px 0;border-bottom:1.5px solid #f1f5f9;overflow-x:auto;">'+
        '<button id="utab-timed" onclick="switchUnlockTab(\'timed\')" style="flex:1;padding:8px 4px;font-size:12px;font-weight:700;border:none;background:none;cursor:pointer;border-bottom:2.5px solid #3b82f6;color:#3b82f6;white-space:nowrap;">시간설정</button>'+
        '<button id="utab-until" onclick="switchUnlockTab(\'until\')" style="flex:1;padding:8px 4px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2.5px solid transparent;color:#94a3b8;white-space:nowrap;">시각지정</button>'+
        '<button id="utab-sched" onclick="switchUnlockTab(\'sched\')" style="flex:1;padding:8px 4px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2.5px solid transparent;color:#94a3b8;white-space:nowrap;">시간표</button>'+
        '<button id="utab-perm" onclick="switchUnlockTab(\'perm\')" style="flex:1;padding:8px 4px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2.5px solid transparent;color:#94a3b8;white-space:nowrap;">완전오픈</button>'+
      '</div>'+
      '<div id="upanel-timed" style="padding:18px 20px;">'+
        '<div style="font-size:13px;color:#64748b;margin-bottom:10px;">몇 분간 상점을 열까요?</div>'+
        '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">'+
          '<button onclick="setUnlockMins(10)" style="padding:7px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#f8fafc;">10분</button>'+
          '<button onclick="setUnlockMins(20)" style="padding:7px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#f8fafc;">20분</button>'+
          '<button onclick="setUnlockMins(30)" style="padding:7px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#f8fafc;">30분</button>'+
          '<button onclick="setUnlockMins(60)" style="padding:7px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#f8fafc;">1시간</button>'+
        '</div>'+
        '<input id="unlockMinsInp" type="number" value="10" min="1" max="480" placeholder="직접 입력 (분)" style="width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;font-weight:700;text-align:center;box-sizing:border-box;">'+
      '</div>'+
      '<div id="upanel-until" style="padding:18px 20px;display:none;">'+
        '<div style="font-size:13px;color:#64748b;margin-bottom:10px;">언제까지 열어둘까요? (오늘 기준)</div>'+
        '<input id="unlockUntilInp" type="time" style="width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:16px;font-weight:700;text-align:center;box-sizing:border-box;">'+
        '<div style="font-size:11px;color:#94a3b8;margin-top:6px;text-align:center;">지정 시각까지 자동으로 닫힙니다</div>'+
      '</div>'+
      '<div id="upanel-sched" style="padding:18px 20px;display:none;">'+
        '<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:14px;font-size:13px;color:#166534;line-height:1.8;">'+
          '<b>시간표 모드로 전환</b><br>'+
          '강제 잠금/오픈이 모두 해제되고<br>'+
          '설정된 수업 시간표대로 자동 운영돼요.<br><br>'+
          '수업 시간 중 → 자동 잠금<br>'+
          '수업 시간 아닐 때 → 자동 열림<br><br>'+
          '<div style="background:#dcfce7;border-radius:6px;padding:6px 10px;font-size:12px;">'+
          '학생별 개인 시간표가 있으면 그게 우선 적용돼요</div>'+
        '</div>'+
      '</div>'+
      '<div id="upanel-perm" style="padding:18px 20px;display:none;">'+
        '<div style="background:#fef9c3;border:1.5px solid #fde047;border-radius:10px;padding:12px 14px;font-size:13px;color:#854d0e;line-height:1.6;">'+
          '<b>완전 오픈</b> 모드입니다.<br>수업 시간표와 관계없이 상점이 항상 열립니다.<br>다시 잠금 버튼을 눌러야 닫힙니다.'+
        '</div>'+
      '</div>'+
      '<div style="display:flex;gap:8px;padding:0 20px 20px;">'+
        '<button id="unlockConfirmBtn" onclick="doUnlockConfirm()" style="flex:1;padding:11px;background:#22c55e;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;">적용</button>'+
        '<button onclick="document.getElementById(\'unlock-modal\').remove()" style="padding:11px 16px;background:#f1f5f9;color:#475569;border:none;border-radius:10px;font-size:14px;cursor:pointer;">취소</button>'+
      '</div>'+
    '</div>'
  document.body.appendChild(modal)
  var now=new Date(); now.setMinutes(now.getMinutes()+30)
  document.getElementById('unlockUntilInp').value=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')
}

// 탭 전환 (시간표 탭 포함)
window.switchUnlockTab=function(tab){
  var tabs=['timed','until','sched','perm']
  tabs.forEach(function(t){
    var btn=document.getElementById('utab-'+t)
    var panel=document.getElementById('upanel-'+t)
    var active=t===tab
    if(btn){btn.style.borderBottomColor=active?'#3b82f6':'transparent';btn.style.color=active?'#3b82f6':'#94a3b8';btn.style.fontWeight=active?'700':'600'}
    if(panel)panel.style.display=active?'block':'none'
  })
}

window.setUnlockMins=function(m){
  var inp=document.getElementById('unlockMinsInp')
  if(inp)inp.value=m
}

// 열기 확인 (시간표 모드 처리 포함)
window.doUnlockConfirm=function(){
  var tab='timed'
  if(document.getElementById('upanel-until').style.display!=='none') tab='until'
  else if(document.getElementById('upanel-sched').style.display!=='none') tab='sched'
  else if(document.getElementById('upanel-perm').style.display!=='none') tab='perm'

  var body={}
  if(tab==='timed'){
    var mins=parseInt(document.getElementById('unlockMinsInp').value)||10
    body={mode:'timed',minutes:mins}
  } else if(tab==='until'){
    var untilVal=document.getElementById('unlockUntilInp').value
    if(!untilVal){toast('시각을 입력해주세요');return}
    var parts=untilVal.split(':')
    var target=new Date()
    target.setHours(parseInt(parts[0]),parseInt(parts[1]),0,0)
    var now=new Date()
    var diffMins=Math.round((target-now)/60000)
    if(diffMins<=0){toast('현재 시각 이후로 설정해주세요');return}
    body={mode:'timed',minutes:diffMins}
  } else if(tab==='sched'){
    body={mode:'schedule'}
  } else {
    body={mode:'permanent'}
  }

  document.getElementById('unlock-modal').remove()
  api('/api/admin/shop/direct-unlock',{method:'POST',body:JSON.stringify(body)}).then(function(d){
    if(d.success){
      var msg=body.mode==='permanent'
        ?'완전 오픈! 잠금 버튼을 누를 때까지 유지됩니다.'
        :body.mode==='schedule'
          ?'시간표 모드로 전환! 수업 시간표에 따라 자동 운영됩니다.'
          :(body.minutes)+'분간 상점이 열렸습니다!'
      toast(msg)
      loadShopStatus()
      loadShopRequests()
    } else toast('오류: '+(d.error||''))
  })
}

window.doDirectUnlock=function(){
  var mins=parseInt(document.getElementById('unlockMinsInp').value)||10
  if(mins<=0)mins=10
  var existing=document.getElementById('unlock-modal')||document.getElementById('unlock-min-modal')
  if(existing)existing.remove()
  api('/api/admin/shop/direct-unlock',{method:'POST',body:JSON.stringify({mode:'timed',minutes:mins})}).then(function(d){
    if(d.success){toast(mins+'분간 상점이 열렸습니다!');loadShopStatus();loadShopRequests()}
    else toast('오류: '+(d.error||''))
  })
}

window.adminLockShop=function(){
  api('/api/admin/shop/lock',{method:'POST'}).then(function(d){
    if(d.success){toast('상점 잠금됨');loadShopStatus();loadShopRequests()}
    else toast('오류: '+(d.error||''))
  })
}

// 재고 현황 조회
function loadStockStatus(){
  var el=document.getElementById('shopStockInfo')
  if(!el)return
  api('/api/shop/stock').then(function(d){
    if(!d.success){el.innerHTML='';return}
    var entries=Object.entries(d.stock||{})
    if(entries.length===0){
      el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">이번 달 재고가 설정되지 않았어요.<br>메뉴설정에서 월 재고를 설정한 뒤 아래 버튼을 누르세요.</div>'
      return
    }
    var monthLabel=d.monthKey||''
    var rows=entries.map(function(kv){
      var id=kv[0], info=kv[1]
      var remain=info.remaining, total=info.initial
      var pct=total>0?Math.round(remain/total*100):0
      var color=pct>50?'#16a34a':pct>20?'#d97706':'#dc2626'
      var barColor=pct>50?'#22c55e':pct>20?'#f59e0b':'#ef4444'
      // 메뉴에서 아이콘/이름 찾기
      var menuItem=(menuCfg.shop||[]).find(function(m){return m.id===id})
      var label=menuItem?(menuItem.icon+' '+menuItem.label):id
      return '<div style="padding:8px 0;border-bottom:1px solid var(--g100);">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
          '<span style="font-size:13px;font-weight:700;">'+esc(label)+'</span>'+
          '<span style="font-size:13px;font-weight:800;color:'+color+';">'+remain+'/'+total+'개</span>'+
        '</div>'+
        '<div style="background:#e2e8f0;border-radius:4px;height:6px;">'+
          '<div style="background:'+barColor+';border-radius:4px;height:6px;width:'+pct+'%;transition:width .3s;"></div>'+
        '</div>'+
      '</div>'
    }).join('')
    el.innerHTML='<div style="font-size:12px;font-weight:800;color:var(--g400);margin-bottom:8px;">'+monthLabel+' 재고 현황</div>'+rows
  }).catch(function(){
    var el=document.getElementById('shopStockInfo')
    if(el)el.innerHTML=''
  })
}

// 이번 달 재고 채우기
window.doRestock=function(){
  var monthKey=new Date().toISOString().slice(0,7)
  if(!confirm(monthKey+' 재고를 메뉴에 설정된 값으로 채울까요?\n(이미 설정된 재고는 초기화됩니다)'))return
  api('/api/admin/shop/restock',{method:'POST'}).then(function(d){
    if(d.success){
      toast(d.itemsRestocked+'개 상품 재고 채움! ('+d.monthKey+')')
      loadStockStatus()
    } else {
      toast('오류: '+(d.error||''))
    }
  })
}

// 시간표 슬롯 렌더링
var DAYS=['월','화','수','목','금','토','일']
function renderScheduleSlots(){
  var el=document.getElementById('scheduleSlots')
  if(!el)return
  if(shopSchedule.length===0){
    el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">추가된 시간대가 없습니다.</div>'
    return
  }
  var html=''
  shopSchedule.forEach(function(sl,i){
    html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
    html+='<select class="sched-day" data-idx="'+i+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    DAYS.forEach(function(d){
      html+='<option value="'+d+'"'+(sl.day===d?' selected':'')+'>'+d+'</option>'
    })
    html+='</select>'
    html+='<input type="time" class="sched-start" data-idx="'+i+'" value="'+(sl.start||'')+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<span style="color:var(--g400);">~</span>'
    html+='<input type="time" class="sched-end" data-idx="'+i+'" value="'+(sl.end||'')+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<button class="btn btn-red btn-sm" onclick="removeScheduleSlot('+i+')"><i class="fas fa-trash"></i></button>'
    html+='</div>'
  })
  el.innerHTML=html
}

window.addScheduleSlot=function(){
  shopSchedule.push({day:'월',start:'14:00',end:'16:00'})
  renderScheduleSlots()
}
window.removeScheduleSlot=function(i){
  shopSchedule.splice(i,1)
  renderScheduleSlots()
}

function collectScheduleFromDOM(){
  var dayEls=document.querySelectorAll('.sched-day')
  var startEls=document.querySelectorAll('.sched-start')
  var endEls=document.querySelectorAll('.sched-end')
  var arr=[]
  dayEls.forEach(function(el,i){
    arr.push({day:el.value,start:startEls[i].value,end:endEls[i].value})
  })
  shopSchedule=arr
}

window.saveSchedule=function(){
  collectScheduleFromDOM()
  api('/api/admin/shop/schedule',{method:'POST',body:JSON.stringify({schedule:shopSchedule})}).then(function(d){
    if(d.success)toast('시간표 저장! 즉시 반영됩니다.')
    else toast('오류: '+(d.error||''))
  })
}

function loadScheduleFromServer(){
  api('/api/admin/shop/schedule').then(function(d){
    if(d.success&&Array.isArray(d.schedule)){
      shopSchedule=d.schedule
    } else {
      shopSchedule=[]
    }
    renderScheduleSlots()
  }).catch(function(){renderScheduleSlots()})
}

// shoplock 탭 활성화 시 재고 포함 전체 로드
var _origSwitchMainTab=window.switchMainTab
window.switchMainTab=function(tab){
  _origSwitchMainTab(tab)
  if(tab==='shoplock'){
    loadShopRequests()
    loadShopStatus()
    loadScheduleFromServer()
    loadStockStatus()
  }
}

})()

// deploy trigger


