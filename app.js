const API = (window.EVENT_APP_CONFIG?.API_BASE || "").replace(/\/$/, "");
const app = document.getElementById("app");
const qs = new URLSearchParams(location.search);
const page = qs.get("page") || "guest";
let adminToken = sessionStorage.getItem("eventAdminToken") || "";
let frameImage = null, cameraStream = null, recorder = null, recordedChunks = [];
let mediaItems = [], liveIndex = 0, liveTimer = null;

function el(tag, attrs={}, html=""){const n=document.createElement(tag);Object.entries(attrs).forEach(([k,v])=>k==="class"?n.className=v:k==="text"?n.textContent=v:n.setAttribute(k,v));if(html)n.innerHTML=html;return n}
function status(msg, bad=false){let s=document.getElementById("status");if(!s){s=el("div",{id:"status",class:"status"});app.prepend(s)}s.textContent=msg;s.className="status"+(bad?" error":"")}
async function api(path, opts={}){const headers={...(opts.headers||{})};if(adminToken)headers.Authorization="Bearer "+adminToken;const r=await fetch(API+path,{...opts,headers});if(!r.ok){let m="Request failed ("+r.status+")";try{m=(await r.json()).error||m}catch{}throw Error(m)}return r.headers.get("content-type")?.includes("application/json")?r.json():r}
function pageShell(title, desc){app.innerHTML=`<section class="panel"><p class="gold small">EVENT PHOTO CLOUD</p><h1>${title}</h1><p class="muted">${desc}</p><div id="status" class="status hidden"></div></section>`}
function showStatus(msg,bad=false){const s=document.getElementById("status");if(s){s.textContent=msg;s.className="status"+(bad?" error":"");s.classList.remove("hidden")}}

async function getConfig(){return api("/api/config")}
async function startUpload(file, kind, framed=false, onProgress=null){
  const init=await api("/api/uploads/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:file.name||`${kind}-${Date.now()}`,mimeType:file.type||"application/octet-stream",size:file.size,kind,framed})});
  const chunkSize=8*1024*1024;let offset=0;
  while(offset<file.size){const end=Math.min(offset+chunkSize,file.size), chunk=file.slice(offset,end);
    const r=await fetch(API+"/api/uploads/"+init.uploadId+"/chunk",{method:"PUT",headers:{"Content-Type":"application/octet-stream","Content-Range":`bytes ${offset}-${end-1}/${file.size}`,...(adminToken?{Authorization:"Bearer "+adminToken}:{})},body:chunk});
    if(!r.ok){let m="Upload chunk failed";try{m=(await r.json()).error||m}catch{}throw Error(m)}
    offset=end;const p=Math.round(offset/file.size*100);if(onProgress)onProgress(p);else showStatus(`Uploading ${kind}: ${p}%`);
  }
  await api("/api/uploads/"+init.uploadId+"/complete",{method:"POST"});
}
function blobFile(blob,name,type){return new File([blob],name,{type:type||blob.type})}

async function guestPage(){
  pageShell("Share the moments.","Capture a photo or video directly with your camera. No gallery uploads are available.");
  const cfg=await getConfig();
  const p=el("section",{class:"panel guest-panel"});
  p.innerHTML=`
    <div id="guestHome" class="guest-home">
      <h2>Capture a memory</h2>
      <p class="muted">Choose how you would like to share your moment.</p>
      <div class="mode-choices">
        <button id="choosePhoto" class="mode-button"><span class="mode-icon">◎</span><strong>Take Photo</strong><small>Capture a framed photo</small></button>
        <button id="chooseVideo" class="mode-button"><span class="mode-icon">▣</span><strong>Take Video</strong><small>Record a short video</small></button>
      </div>
    </div>

    <div id="captureMode" class="capture-mode hidden">
      <div class="capture-heading">
        <div><p class="gold small">GUEST CAMERA</p><h2 id="modeTitle">Take Photo</h2></div>
        <button id="backHome" class="secondary">Back</button>
      </div>

      <div id="framePicker" class="frame-picker hidden">
        <button id="framePrev" class="icon-button secondary" aria-label="Previous frame">‹</button>
        <div class="frame-choice"><span id="frameChoiceName">Event Frame</span><small>Swipe left or right to change</small></div>
        <button id="frameNext" class="icon-button secondary" aria-label="Next frame">›</button>
      </div>

      <div id="cameraStage" class="camera-stage">
        <video id="guestCamera" autoplay playsinline muted></video>
        <img id="cameraFrame" class="camera-frame hidden" alt="Selected photo frame">
        <div id="recordTimer" class="record-timer hidden">00:00</div>
      </div>

      <div id="cameraActions" class="camera-actions">
        <button id="switchCamera" class="secondary small-action">Switch camera</button>
        <button id="photoShutter" class="shutter-button" aria-label="Take photo"><span class="camera-glyph">📷</span></button>
        <button id="videoRecord" class="record-button hidden" aria-label="Start recording"><span></span></button>
      </div>

      <div id="photoReview" class="review-area hidden">
        <img id="photoResult" class="capture-result" alt="Your captured photo">
        <div class="review-actions"><button id="retakePhoto" class="secondary">Retake</button><button id="uploadPhoto">Upload Photo</button></div>
      </div>

      <div id="videoReview" class="review-area hidden">
        <video id="videoResult" class="capture-result" playsinline autoplay muted loop></video>
        <p id="videoDetails" class="muted small"></p>
        <div id="videoProgressWrap" class="upload-progress hidden"><div class="progress"><i id="videoProgressBar"></i></div><p id="videoProgressText" class="small">Preparing upload…</p></div>
        <div class="review-actions"><button id="retakeVideo" class="secondary">Retake</button><button id="uploadVideo">Upload Video</button></div>
      </div>
      <p id="captureHint" class="muted small capture-hint"></p>
    </div>`;
  app.append(p);

  const $=s=>p.querySelector(s);
  const home=$("#guestHome"), mode=$("#captureMode"), camera=$("#guestCamera"), cameraStage=$("#cameraStage");
  const cameraFrame=$("#cameraFrame"), framePicker=$("#framePicker"), photoReview=$("#photoReview"), videoReview=$("#videoReview");
  let facing="environment", currentMode="", photoBlob=null, videoBlob=null, photoUrl="", videoUrl="", frameUrl="";
  let selectedFrame=cfg.frameUrl?0:1, recorderInstance=null, chunks=[], recordingStarted=0, timerHandle=null, uploading=false;
  let recordingCanvas=null, recordingStream=null, recordingRaf=0;
  const frameOptions=cfg.frameUrl?[{name:"Event Frame",url:API+cfg.frameUrl},{name:"No Frame",url:null}]:[{name:"No Frame",url:null}];
  let frameImage=null;

  if(cfg.frameUrl){
    frameImage=new Image();
    frameImage.crossOrigin="anonymous";
    frameImage.src=API+cfg.frameUrl;
    cameraFrame.src=API+cfg.frameUrl;
    frameImage.onload=()=>{if(!cameraStage.classList.contains("hidden"))cameraFrame.classList.toggle("hidden",!frameOptions[selectedFrame]?.url)};
  }

  function stopCamera(){
    if(cameraStream){cameraStream.getTracks().forEach(track=>track.stop());cameraStream=null;}
    camera.srcObject=null;
  }
  function stopCompositeRecording(){
    if(recordingRaf)cancelAnimationFrame(recordingRaf);
    recordingRaf=0;
    if(recordingStream){recordingStream.getTracks().forEach(track=>track.stop());recordingStream=null;}
    recordingCanvas=null;
  }
  function createRecordingStream(){
    if(!camera.videoWidth||!camera.videoHeight)throw Error("Camera is not ready yet. Please try again.");
    if(!HTMLCanvasElement.prototype.captureStream)throw Error("This browser does not support framed video recording. Please use an updated Chrome or Safari.");
    if(frameOptions[selectedFrame]?.url&&(!frameImage?.complete||!frameImage.naturalWidth))throw Error("The event frame is still loading. Please wait a moment and try again.");
    recordingCanvas=document.createElement("canvas");
    recordingCanvas.width=camera.videoWidth;
    recordingCanvas.height=camera.videoHeight;
    const ctx=recordingCanvas.getContext("2d");
    const drawFrame=()=>{
      if(!recordingCanvas)return;
      ctx.drawImage(camera,0,0,recordingCanvas.width,recordingCanvas.height);
      if(frameOptions[selectedFrame]?.url&&frameImage?.complete&&frameImage.naturalWidth){
        ctx.drawImage(frameImage,0,0,recordingCanvas.width,recordingCanvas.height);
      }
      recordingRaf=requestAnimationFrame(drawFrame);
    };
    drawFrame();
    recordingStream=recordingCanvas.captureStream(30);
    cameraStream.getAudioTracks().forEach(track=>recordingStream.addTrack(track));
    return recordingStream;
  }
  function stopTimer(){if(timerHandle){clearInterval(timerHandle);timerHandle=null;}}
  function clearPreviewUrls(){
    if(photoUrl){URL.revokeObjectURL(photoUrl);photoUrl="";}
    if(videoUrl){URL.revokeObjectURL(videoUrl);videoUrl="";}
  }
  function resetCapture(){
    stopTimer();
    if(recorderInstance && recorderInstance.state!=="inactive"){try{recorderInstance.onstop=null;recorderInstance.stop()}catch{}}
    stopCamera();
    stopCompositeRecording();
    const oldPlayer=$("#videoResult");if(oldPlayer){oldPlayer.pause();oldPlayer.removeAttribute("src");oldPlayer.load();}
    clearPreviewUrls();photoBlob=null;videoBlob=null;chunks=[];recorderInstance=null;uploading=false;
    photoReview.classList.add("hidden");videoReview.classList.add("hidden");cameraStage.classList.remove("hidden");$("#cameraActions").classList.remove("hidden");
    $("#videoProgressWrap").classList.add("hidden");$("#videoProgressBar").style.width="0%";
    $("#uploadPhoto").disabled=false;$("#uploadVideo").disabled=false;
    cameraFrame.classList.toggle("hidden",!frameOptions[selectedFrame]?.url);
    $("#recordTimer").classList.add("hidden");
  }
  async function openCamera(withAudio){
    stopCamera();
    if(!navigator.mediaDevices?.getUserMedia)throw Error("Camera access is not supported in this browser. Please use a recent version of Chrome or Safari.");
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}},audio:!!withAudio});
    camera.srcObject=cameraStream;
    await new Promise((resolve,reject)=>{if(camera.readyState>=1)return resolve();camera.onloadedmetadata=resolve;camera.onerror=()=>reject(Error("Unable to start camera preview."));});
    await camera.play();
  }
  function setFrame(index){
    selectedFrame=(index+frameOptions.length)%frameOptions.length;
    $("#frameChoiceName").textContent=frameOptions[selectedFrame].name;
    cameraFrame.classList.toggle("hidden",!frameOptions[selectedFrame].url);
  }
  function changeFrame(direction){if(frameOptions.length>1)setFrame(selectedFrame+direction);}
  $("#framePrev").onclick=()=>changeFrame(-1);
  $("#frameNext").onclick=()=>changeFrame(1);
  let swipeX=0;
  framePicker.addEventListener("pointerdown",e=>{swipeX=e.clientX});
  framePicker.addEventListener("pointerup",e=>{const dx=e.clientX-swipeX;if(Math.abs(dx)>45)changeFrame(dx<0?1:-1)});

  async function enterMode(which){
    currentMode=which;resetCapture();home.classList.add("hidden");mode.classList.remove("hidden");
    $("#modeTitle").textContent=which==="photo"?"Take Photo":"Take Video";
    framePicker.classList.remove("hidden");
    $("#photoShutter").classList.toggle("hidden",which!=="photo");
    $("#videoRecord").classList.toggle("hidden",which!=="video");
    cameraFrame.classList.toggle("hidden",!frameOptions[selectedFrame]?.url);
    $("#captureHint").textContent=which==="photo"?"Choose a frame, then tap the camera button to capture your photo.":"Choose a frame, then tap the square to start recording. The frame will appear in your video.";
    setFrame(selectedFrame);
    try{await openCamera(which==="video");$("#cameraActions").classList.remove("hidden");}
    catch(e){showStatus(e.message,true);mode.classList.add("hidden");home.classList.remove("hidden");}
  }
  $("#choosePhoto").onclick=()=>enterMode("photo");
  $("#chooseVideo").onclick=()=>enterMode("video");
  $("#backHome").onclick=()=>{resetCapture();mode.classList.add("hidden");home.classList.remove("hidden");currentMode="";};
  $("#switchCamera").onclick=async()=>{facing=facing==="environment"?"user":"environment";try{await openCamera(currentMode==="video")}catch(e){showStatus(e.message,true)}};

  $("#photoShutter").onclick=async()=>{
    if(!cameraStream||!camera.videoWidth)return showStatus("Please wait for the camera to start.",true);
    const shot=document.createElement("canvas");shot.width=camera.videoWidth;shot.height=camera.videoHeight;
    const ctx=shot.getContext("2d");ctx.drawImage(camera,0,0,shot.width,shot.height);
    if(frameOptions[selectedFrame]?.url&&frameImage?.complete&&frameImage.naturalWidth)ctx.drawImage(frameImage,0,0,shot.width,shot.height);
    photoBlob=await new Promise(resolve=>shot.toBlob(resolve,"image/jpeg",.94));
    if(!photoBlob)return showStatus("Unable to capture this photo. Please try again.",true);
    photoUrl=URL.createObjectURL(photoBlob);$("#photoResult").src=photoUrl;
    stopCamera();cameraStage.classList.add("hidden");$("#cameraActions").classList.add("hidden");photoReview.classList.remove("hidden");
    $("#captureHint").textContent="Review your photo. You can retake it or upload it to the event gallery.";
  };
  $("#retakePhoto").onclick=async()=>{resetCapture();try{await openCamera(false)}catch(e){showStatus(e.message,true)}};
  $("#uploadPhoto").onclick=async()=>{
    if(!photoBlob||uploading)return;uploading=true;$("#uploadPhoto").disabled=true;$("#retakePhoto").disabled=true;
    try{await startUpload(blobFile(photoBlob,`event-photo-${Date.now()}.jpg`,"image/jpeg"),"photo",false,pct=>{$("#captureHint").textContent=`Uploading photo: ${pct}%`;});
      resetCapture();mode.classList.add("hidden");home.classList.remove("hidden");currentMode="";showStatus("Photo uploaded. Thank you!");
    }catch(e){uploading=false;$("#uploadPhoto").disabled=false;$("#retakePhoto").disabled=false;showStatus(e.message,true)}
  };

  function formatTime(ms){const sec=Math.floor(ms/1000);return String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0")}
  function supportedRecorderType(){return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(t=>window.MediaRecorder?.isTypeSupported?.(t))||""}
  function startTimer(){recordingStarted=Date.now();const timer=$("#recordTimer");timer.textContent="00:00";timer.classList.remove("hidden");timerHandle=setInterval(()=>{timer.textContent=formatTime(Date.now()-recordingStarted)},250)}
  $("#videoRecord").onclick=()=>{
    if(!cameraStream)return showStatus("Please wait for the camera to start.",true);
    if(!recorderInstance||recorderInstance.state==="inactive"){
      try{
        chunks=[];const mimeType=supportedRecorderType();const captureStream=createRecordingStream();recorderInstance=new MediaRecorder(captureStream,mimeType?{mimeType}:undefined);
        recorderInstance.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
        recorderInstance.onerror=()=>showStatus("Recording failed. Please try again.",true);
        recorderInstance.onstop=()=>{
          stopTimer();videoBlob=new Blob(chunks,{type:recorderInstance.mimeType||"video/webm"});
          if(videoBlob.size>500*1024*1024){videoBlob=null;showStatus("This video exceeds 500 MB. Please record a shorter video.",true);return;}
          videoUrl=URL.createObjectURL(videoBlob);const player=$("#videoResult");player.src=videoUrl;player.currentTime=0;player.play().catch(()=>{});
          $("#videoDetails").textContent=`Video ready · ${(videoBlob.size/1024/1024).toFixed(1)} MB`;
          stopCamera();stopCompositeRecording();cameraStage.classList.add("hidden");$("#cameraActions").classList.add("hidden");videoReview.classList.remove("hidden");
          $("#captureHint").textContent="Your video is previewing on loop with the selected frame included. Retake it or upload it to the event gallery.";
        };
        recorderInstance.start(1000);$("#videoRecord").classList.add("is-recording");$("#videoRecord").setAttribute("aria-label","Stop recording");startTimer();
      }catch(e){stopCompositeRecording();showStatus("Unable to start video recording: "+e.message,true)}
    }else if(recorderInstance.state==="recording"){
      recorderInstance.stop();$("#videoRecord").classList.remove("is-recording");$("#videoRecord").setAttribute("aria-label","Start recording");
    }
  };
  $("#retakeVideo").onclick=async()=>{const player=$("#videoResult");player.pause();player.removeAttribute("src");player.load();resetCapture();try{await openCamera(true)}catch(e){showStatus(e.message,true)}};
  $("#uploadVideo").onclick=async()=>{
    if(!videoBlob||uploading)return;uploading=true;
    const player=$("#videoResult");player.pause();
    $("#retakeVideo").disabled=true;$("#uploadVideo").disabled=true;$("#videoProgressWrap").classList.remove("hidden");
    try{
      await startUpload(blobFile(videoBlob,`event-video-${Date.now()}.webm`,videoBlob.type),"video",false,pct=>{$("#videoProgressBar").style.width=pct+"%";$("#videoProgressText").textContent=`Uploading video… ${pct}%`;});
      $("#videoProgressText").textContent="Upload complete!";resetCapture();mode.classList.add("hidden");home.classList.remove("hidden");currentMode="";showStatus("Video uploaded. Thank you!");
    }catch(e){uploading=false;$("#retakeVideo").disabled=false;$("#uploadVideo").disabled=false;showStatus(e.message,true)}
  };

  const comments=el("section",{class:"panel"});
  comments.innerHTML=`<h2>Leave a message</h2><input id="nickname" maxlength="40" placeholder="Your name (optional)"><textarea id="commentText" maxlength="300" placeholder="Write a message for the couple…"></textarea><button id="sendComment">Post comment</button>`;app.append(comments);
  comments.querySelector("#sendComment").onclick=async()=>{const message=comments.querySelector("#commentText").value.trim();if(!message)return;try{await api("/api/comments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:comments.querySelector("#nickname").value.trim(),message})});comments.querySelector("#commentText").value="";showStatus("Comment posted.")}catch(e){showStatus(e.message,true)}};
}
async function adminPage(){
  pageShell("Event administration","Configure your event, upload the custom PNG frame and moderate guest comments.");
  const box=el("section",{class:"panel"});app.append(box);
  if(!adminToken){box.innerHTML=`<h2>Admin login</h2><label>Admin password</label><input id="pw" type="password" placeholder="Admin password"><button id="login">Sign in</button>`;box.querySelector("#login").onclick=async()=>{try{const x=await api("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:box.querySelector("#pw").value})});adminToken=x.token;sessionStorage.setItem("eventAdminToken",adminToken);adminPage()}catch(e){showStatus(e.message,true)}};return}
  box.innerHTML=`<h2>Event settings</h2><p class="muted">The event upload window is configured securely on the server using EVENT_START and EVENT_END.</p>
    <label>Custom PNG photo frame</label><input id="frameFile" type="file" accept="image/png"><button id="uploadFrame">Upload PNG frame</button>
    <div class="actions"><a href="?page=live" target="_blank">Open live slideshow</a><button id="refresh" class="secondary">Refresh comments</button><button id="logout" class="secondary">Log out</button></div><h2>Comments moderation</h2><div id="moderation"></div>`;
  box.querySelector("#logout").onclick=()=>{adminToken="";sessionStorage.removeItem("eventAdminToken");adminPage()};
  box.querySelector("#uploadFrame").onclick=async()=>{const f=box.querySelector("#frameFile").files[0];if(!f)return showStatus("Choose a PNG file.",true);if(f.type!=="image/png")return showStatus("Only PNG frames are accepted.",true);try{await startUpload(f,"frame");await api("/api/admin/frame",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:f.name})});showStatus("Frame uploaded and activated.")}catch(e){showStatus(e.message,true)}};
  async function loadComments(){try{const data=await api("/api/admin/comments");const list=box.querySelector("#moderation");list.innerHTML="";data.comments.forEach(c=>{const d=el("div",{class:"tile"});d.style.padding="12px";d.innerHTML=`<strong></strong><p></p><div class="actions"><button class="danger">Delete</button></div>`;d.querySelector("strong").textContent=c.name||"Guest";d.querySelector("p").textContent=c.message;d.querySelector("button").onclick=async()=>{await api("/api/admin/comments/"+c.id,{method:"DELETE"});loadComments()};list.append(d)})}catch(e){showStatus(e.message,true)}}
  box.querySelector("#refresh").onclick=loadComments;loadComments();
}

async function livePage(){
  pageShell("Live event slideshow","Admin sign-in is required because the live gallery contains private event media.");
  if(!adminToken){
    const login=el("section",{class:"panel"});login.innerHTML=`<h2>Admin sign-in</h2><label>Admin password</label><input id="livePw" type="password"><button id="liveLogin">Sign in and open slideshow</button>`;app.append(login);
    login.querySelector("#liveLogin").onclick=async()=>{try{const x=await api("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:login.querySelector("#livePw").value})});adminToken=x.token;sessionStorage.setItem("eventAdminToken",adminToken);livePage()}catch(e){showStatus(e.message,true)}};return;
  }
  app.innerHTML+=`<section class="panel"><div id="liveStage"><div class="muted">Waiting for guest uploads…</div><div id="comments"></div></div><div class="actions"><button id="prev" class="secondary">Previous</button><button id="next">Next</button><button id="pause" class="secondary">Pause slideshow</button><button id="full">Full screen</button></div><p id="liveCount" class="small"></p></section>`;
  const stage=document.getElementById("liveStage"), comments=document.getElementById("comments");
  async function refresh(){try{const data=await api("/api/live");mediaItems=data.media;comments.innerHTML="";data.comments.slice(-5).forEach(c=>{const x=el("div",{class:"comment"});x.textContent=(c.name?c.name+": ":"")+c.message;comments.append(x)});document.getElementById("liveCount").textContent=`${mediaItems.length} media item(s) · Auto-refreshing`;
    if(mediaItems.length){if(liveIndex>=mediaItems.length)liveIndex=0;await showCurrent()}
  }catch(e){showStatus(e.message,true)}}
  async function showCurrent(){const item=mediaItems[liveIndex];if(!item)return;stage.querySelectorAll("#liveMedia").forEach(x=>x.remove());const r=await fetch(API+"/api/media/"+item.id,{headers:{Authorization:"Bearer "+adminToken}});if(!r.ok)throw Error("Unable to load private media.");const blob=await r.blob();const url=URL.createObjectURL(blob);let node;if(item.mimeType?.startsWith("video/")){node=el("video",{id:"liveMedia",controls:"",autoplay:"",playsinline:""});node.src=url}else{node=el("img",{id:"liveMedia"});node.src=url}stage.insertBefore(node,comments)}
  document.getElementById("prev").onclick=()=>{if(mediaItems.length){liveIndex=(liveIndex-1+mediaItems.length)%mediaItems.length;showCurrent()}};
  document.getElementById("next").onclick=()=>{if(mediaItems.length){liveIndex=(liveIndex+1)%mediaItems.length;showCurrent()}};
  let paused=false;document.getElementById("pause").onclick=e=>{paused=!paused;e.target.textContent=paused?"Resume slideshow":"Pause slideshow"};
  document.getElementById("full").onclick=()=>stage.requestFullscreen?.();
  refresh();setInterval(refresh,7000);liveTimer=setInterval(()=>{if(!paused&&mediaItems.length){liveIndex=(liveIndex+1)%mediaItems.length;showCurrent()}},9000);
}

(async()=>{try{if(!API||API.includes("YOUR-CLOUD"))throw Error("Set API_BASE in public/config.js to your Cloud Run URL.");if(page==="admin")await adminPage();else if(page==="live")await livePage();else await guestPage()}catch(e){app.innerHTML=`<section class="panel"><h1>Unable to load event</h1><p class="muted"></p></section>`;app.querySelector("p").textContent=e.message}})();
