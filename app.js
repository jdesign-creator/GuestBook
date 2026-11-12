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
async function startUpload(file, kind, framed=false){
  const init=await api("/api/uploads/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:file.name||`${kind}-${Date.now()}`,mimeType:file.type||"application/octet-stream",size:file.size,kind,framed})});
  const chunkSize=8*1024*1024;let offset=0;
  while(offset<file.size){const end=Math.min(offset+chunkSize,file.size), chunk=file.slice(offset,end);
    const r=await fetch(API+"/api/uploads/"+init.uploadId+"/chunk",{method:"PUT",headers:{"Content-Type":"application/octet-stream","Content-Range":`bytes ${offset}-${end-1}/${file.size}`,...(adminToken?{Authorization:"Bearer "+adminToken}:{})},body:chunk});
    if(!r.ok){let m="Upload chunk failed";try{m=(await r.json()).error||m}catch{}throw Error(m)}
    offset=end;const p=Math.round(offset/file.size*100);showStatus(`Uploading ${kind}: ${p}%`);
  }
  await api("/api/uploads/"+init.uploadId+"/complete",{method:"POST"});
}
function blobFile(blob,name,type){return new File([blob],name,{type:type||blob.type})}

async function guestPage(){
  pageShell("Share the moments.","Take a photo or record a video directly in this page. Uploads from your phone gallery are not available.");
  const cfg=await getConfig();
  const p=el("section",{class:"panel"});
  p.innerHTML=`<h2>1. Take a photo</h2><p class="muted">Allow camera access. Your custom event frame will appear over the preview.</p>
    <div class="capture"><video id="camera" autoplay playsinline muted></video><canvas id="overlay"></canvas></div>
    <div class="actions"><button id="startCam">Open camera</button><button id="switchCam" class="secondary">Switch camera</button><button id="snap">Take photo</button></div>
    <img id="photoPreview" class="preview hidden"><div class="actions"><button id="uploadPhoto" disabled>Upload photo</button><button id="retake" class="secondary hidden">Retake</button></div>
    <hr style="border-color:#2b3b52;margin:24px 0">
    <h2>2. Record a video</h2><p class="muted">Maximum video size: 500 MB. Keep this page open while uploading.</p>
    <div class="actions"><button id="record">Start recording</button><button id="stopRecord" class="secondary" disabled>Stop recording</button><button id="uploadVideo" disabled>Upload video</button></div>
    <p id="videoInfo" class="small"></p>`;
  app.append(p);
  const video=p.querySelector("#camera"), preview=p.querySelector("#photoPreview"), canvas=p.querySelector("#overlay");
  let facing="environment", photoBlob=null, videoBlob=null;
  if(cfg.frameUrl){frameImage=new Image();frameImage.crossOrigin="anonymous";frameImage.src=cfg.frameUrl.startsWith("http")?cfg.frameUrl:(API+cfg.frameUrl);frameImage.onload=()=>drawOverlay();}
  function drawOverlay(){canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||480;const c=canvas.getContext("2d");c.clearRect(0,0,canvas.width,canvas.height);if(frameImage?.complete)c.drawImage(frameImage,0,0,canvas.width,canvas.height)}
  async function openCamera(){if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing},audio:true});video.srcObject=cameraStream;video.onloadedmetadata=drawOverlay}
  p.querySelector("#startCam").onclick=()=>openCamera().catch(e=>showStatus(e.message,true));
  p.querySelector("#switchCam").onclick=()=>{facing=facing==="environment"?"user":"environment";openCamera().catch(e=>showStatus(e.message,true))};
  p.querySelector("#snap").onclick=async()=>{if(!cameraStream)return showStatus("Open the camera first.",true);const c=document.createElement("canvas");c.width=video.videoWidth;c.height=video.videoHeight;c.getContext("2d").drawImage(video,0,0);photoBlob=await new Promise(r=>c.toBlob(r,"image/jpeg",.96));if(frameImage?.complete){const out=document.createElement("canvas");out.width=c.width;out.height=c.height;out.getContext("2d").drawImage(c,0,0);out.getContext("2d").drawImage(frameImage,0,0,c.width,c.height);photoBlob.framed=await new Promise(r=>out.toBlob(r,"image/png"))}preview.src=URL.createObjectURL(photoBlob);preview.classList.remove("hidden");p.querySelector("#uploadPhoto").disabled=false;p.querySelector("#retake").classList.remove("hidden")};
  p.querySelector("#retake").onclick=()=>{photoBlob=null;preview.classList.add("hidden");p.querySelector("#uploadPhoto").disabled=true};
  p.querySelector("#uploadPhoto").onclick=async()=>{try{if(!photoBlob) return;await startUpload(blobFile(photoBlob,"event-photo.jpg","image/jpeg"),"photo");if(photoBlob.framed)await startUpload(blobFile(photoBlob.framed,"event-photo-framed.png","image/png"),"framed-photo",true);showStatus("Photo uploaded. Thank you!");p.querySelector("#uploadPhoto").disabled=true}catch(e){showStatus(e.message,true)}};
  p.querySelector("#record").onclick=()=>{if(!cameraStream)return showStatus("Open the camera first.",true);recordedChunks=[];recorder=new MediaRecorder(cameraStream);recorder.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data)};recorder.onstop=()=>{videoBlob=new Blob(recordedChunks,{type:recorder.mimeType||"video/webm"});p.querySelector("#videoInfo").textContent=`Recorded ${(videoBlob.size/1024/1024).toFixed(1)} MB`;p.querySelector("#uploadVideo").disabled=videoBlob.size>500*1024*1024;if(videoBlob.size>500*1024*1024)showStatus("This video exceeds 500 MB. Please record a shorter clip.",true)};recorder.start(1000);p.querySelector("#record").disabled=true;p.querySelector("#stopRecord").disabled=false};
  p.querySelector("#stopRecord").onclick=()=>{recorder?.stop();p.querySelector("#record").disabled=false;p.querySelector("#stopRecord").disabled=true};
  p.querySelector("#uploadVideo").onclick=async()=>{try{await startUpload(blobFile(videoBlob,"event-video.webm",videoBlob.type),"video");showStatus("Video uploaded. Thank you!");p.querySelector("#uploadVideo").disabled=true}catch(e){showStatus(e.message,true)}};
  const comments=el("section",{class:"panel"});comments.innerHTML=`<h2>Leave a message</h2><input id="nickname" maxlength="40" placeholder="Your name (optional)"><textarea id="commentText" maxlength="300" placeholder="Write a message for the couple…"></textarea><button id="sendComment">Post comment</button>`;app.append(comments);
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
