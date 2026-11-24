const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let me = null, cats = [], editId = null, editOriginalHours = "", picking = false, registerMode = false;
let theme = localStorage.getItem("vologda-theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
const markers = {};
let suggestionTimer = null, suggestionRequestId = 0, activeSuggestionIndex = -1;
const map = L.map("map").setView([59.2187, 39.8886], 12);
map.attributionControl.setPrefix(false);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1
  }).addTo(map);
const layer = L.layerGroup().addTo(map);
const markerIcon = L.divIcon({
  className: "map-pin-icon",
  html: `<span class="map-pin"><svg viewBox="0 0 40 48" aria-hidden="true"><path class="map-pin-shape" d="M20 47S2 27.8 2 18.7a18 18 0 1 1 36 0C38 27.8 20 47 20 47Z"/><circle class="map-pin-ring" cx="20" cy="18.5" r="9.2"/><path class="map-pin-mark" d="m16.2 19.1 2.5 2.5 5.3-6"/></svg></span>`,
  iconSize: [40, 48],
  iconAnchor: [20, 46],
  popupAnchor: [0, -42]
});

async function api(url, method = "GET", body) {
  const r = await fetch(url, {method, headers: body ? {"Content-Type": "application/json"} : {},
                              body: body ? JSON.stringify(body) : undefined});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Ошибка запроса");
  return d;
}
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.classList.add("show");
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove("show"), 2500);
}
document.addEventListener("click", e => { if (e.target.dataset.close !== undefined) e.target.closest("dialog").close(); });
const catName = id => (cats.find(c => c.id === id) || {}).name || "";
const isAdmin = () => me && me.role === "administrator";
function displayAddress(value) {
  const parts = String(value || "").split(",").map(part => part.trim()).filter(Boolean);
  const city = parts.find(part => /^(?:г\.?\s*)?(Вологда|Череповец|Кириллов|Тотьма|Великий Устюг|Белозерск|Устюжна|Вытегра)\b/i.test(part));
  const street = parts.find(part => /\b(?:ул\.?|улица|проспект|пр-т|площадь|пл\.?|набережная|наб\.?|шоссе|переулок|пер\.)\b/i.test(part));
  const location = parts.find(part => /\b(?:д\.?|деревня|с\.?|село|остров|монастырь|вотчина)\b/i.test(part));
  const address = [city, street || location].filter(Boolean).join(", ");
  return address || parts.join(", ") || "Адрес уточняется";
}

/* ---------- шапка ---------- */
function renderNav() {
  const nav = $("#nav"); nav.innerHTML = "";
  const add = (text, fn, cls = "btn") => { const b = document.createElement("button"); b.className = cls; b.textContent = text; b.onclick = fn; nav.append(b); };
  add(theme === "dark" ? "☀ Светлая тема" : "☾ Тёмная тема", toggleTheme, "btn theme-toggle");
  if (!me) { add("Войти", () => openAuth(false)); add("Регистрация", () => openAuth(true)); return; }
  const w = document.createElement("span"); w.className = "who";
  w.textContent = me.username + (isAdmin() ? " (администратор)" : ""); nav.append(w);
  add(isAdmin() ? "Добавить объект" : "Предложить точку", () => openObj());
  add(isAdmin() ? "Заявки" : "Мои заявки", openRequests);
  add("Выйти", async () => {
    await api("/api/logout", "POST");
    me = null;
    editId = null;
    editOriginalHours = "";
    picking = false;
    document.body.classList.remove("picking");
    if ($("#objDlg").open) $("#objDlg").close();
    $("#objDock").hidden = true;
    $("#objForm").reset();
    renderNav();
    loadObjects();
  });
}
function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("vologda-theme", theme);
  renderNav();
}

/* ---------- вход / регистрация ---------- */
function openAuth(reg) {
  registerMode = reg;
  $("#authTitle").textContent = reg ? "Регистрация" : "Вход";
  $("#authOk").textContent = reg ? "Создать аккаунт" : "Войти";
  $("#aMailRow").hidden = !reg; $("#aMail").required = reg;
  $("#consentRow").hidden = !reg;
  $("#authSwitch").textContent = reg ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Зарегистрироваться";
  $("#authErr").textContent = ""; $("#authDlg").showModal();
}
$("#authSwitch").onclick = () => openAuth(!registerMode);
document.querySelectorAll("[data-password-toggle]").forEach(button => {
  button.addEventListener("click", () => {
    const input = $("#" + button.dataset.passwordToggle);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Скрыть" : "Показать";
    button.setAttribute("aria-label", visible ? "Скрыть пароль" : "Показать пароль");
    button.setAttribute("aria-pressed", String(visible));
  });
});
$("#authForm").onsubmit = async e => {
  e.preventDefault();
  if (registerMode && !($("#aConsentPersonal").checked && $("#aConsentPolicy").checked)) {
    $("#authErr").textContent = "Чтобы зарегистрироваться, необходимо дать согласие на обработку персональных данных и принять политику конфиденциальности";
    return;
  }
  try {
    me = await api(registerMode ? "/api/register" : "/api/login", "POST",
      {username: $("#aUser").value, email: $("#aMail").value, password: $("#aPass").value});
    $("#authDlg").close(); $("#authForm").reset(); renderNav(); loadObjects(); toast("Вы вошли как " + me.username);
  } catch (x) { $("#authErr").textContent = x.message; }
};

/* ---------- объекты на карте ---------- */
function selectedCats() { return [...document.querySelectorAll("#cats input:checked")].map(i => i.value); }

async function loadObjects(preloadedItems, {preserveView = false} = {}) {
  const previousCenter = preserveView ? map.getCenter() : null;
  const previousZoom = preserveView ? map.getZoom() : null;
  let items = preloadedItems;
  if (!items) {
    const p = new URLSearchParams({q: $("#q").value.trim(), categories: selectedCats().join(",")});
    items = await api("/api/objects?" + p);
  }
  layer.clearLayers(); Object.keys(markers).forEach(k => delete markers[k]);
  const list = $("#list"); list.innerHTML = "";
  items.forEach(o => {
    const m = L.marker([o.lat, o.lon], {icon: markerIcon, title: o.name, alt: o.name, bubblingMouseEvents: false})
      .bindPopup(popupFor(o));
    m.on("dblclick", event => {
      if (event.originalEvent) {
        event.originalEvent.preventDefault();
        event.originalEvent.stopPropagation();
      }
    });
    m.addTo(layer); markers[o.id] = m;
    const li = document.createElement("li");
    li.innerHTML = `<button><b>${esc(o.name)}</b><span>${esc(catName(o.category_id))} · ${esc(displayAddress(o.address))}</span></button>`;
    li.firstChild.onclick = () => { map.setView([o.lat, o.lon], 16); m.openPopup(); };
    list.append(li);
  });
  $("#count").textContent = items.length ? `Найдено объектов: ${items.length}` : "Ничего не найдено. Измените запрос или сбросьте фильтры.";
  if (preserveView) map.setView(previousCenter, previousZoom, {animate: false});
  else if (items.length && ($("#q").value || selectedCats().length)) map.fitBounds(L.latLngBounds(items.map(o => [o.lat, o.lon])).pad(.3), {maxZoom: 16});
}

function popupFor(o) {
  const el = document.createElement("div"); el.className = "popup";
  el.innerHTML = `<h3>${esc(o.name)}</h3><p><b>${esc(catName(o.category_id))}</b></p><p>${esc(o.address)}</p>` +
    (o.description ? `<p>${esc(o.description)}</p>` : "") +
    (o.phone ? `<p>Телефон: ${esc(o.phone)}</p>` : "") + (o.working_hours ? `<p>Часы работы: ${esc(o.working_hours)}</p>` : "");
  if (isAdmin()) {
    const a = document.createElement("div"); a.className = "acts";
    a.innerHTML = `<button class="btn">Изменить</button><button class="btn danger">Удалить</button>`;
    a.children[0].onclick = () => openObj(o);
    a.children[1].onclick = async () => {
      if (!confirm(`Удалить «${o.name}»?`)) return;
      try { await api("/api/objects/" + o.id, "DELETE"); toast("Объект удалён"); loadObjects(undefined, {preserveView: true}); }
      catch (x) { toast(x.message); }
    };
    el.append(a);
  }
  return el;
}

/* ---------- форма объекта ---------- */
function openObj(o) {
  if (!me) return openAuth(false);
  editId = o ? o.id : null;
  editOriginalHours = String(o?.working_hours || "");
  $("#objTitle").textContent = o ? "Изменить объект" : (isAdmin() ? "Новый объект" : "Предложить точку");
  $("#oCat").innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const set = (id, v) => $(id).value = v ?? "";
  set("#oName", o?.name); set("#oAddr", o?.address); set("#oDesc", o?.description); set("#oPhone", o?.phone);
  const hours = String(o?.working_hours || "");
  const hoursMatch = hours.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
  $("#oHoursFrom").value = hoursMatch ? hoursMatch[1].padStart(5, "0") : "";
  $("#oHoursTo").value = hoursMatch ? hoursMatch[2].padStart(5, "0") : "";
  $("#oHoursLegacy").hidden = !hours || !!hoursMatch;
  $("#oHoursLegacy").textContent = hoursMatch ? "" : (hours ? `Сохранено ранее: ${hours}. Укажите новое время, чтобы заменить.` : "");
  set("#oLat", o?.lat); set("#oLon", o?.lon); if (o) $("#oCat").value = o.category_id;
  $("#objErr").textContent = ""; map.closePopup(); $("#objDlg").showModal();
  $("#objDock").hidden = true;
}
function formatRuPhone(value) {
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("8") || digits.startsWith("7")) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  let result = "+7";
  if (digits.length) result += `-${digits.slice(0, 3)}`;
  if (digits.length > 3) result += `-${digits.slice(3, 6)}`;
  if (digits.length > 6) result += `-${digits.slice(6, 8)}`;
  if (digits.length > 8) result += `-${digits.slice(8, 10)}`;
  return result;
}
$("#oPhone").addEventListener("input", e => {
  const value = e.target.value;
  if (!value.trim()) return;
  e.target.value = formatRuPhone(value);
});
$("#minimizeObjBtn").onclick = () => {
  const title = $("#objTitle").textContent;
  $("#objDockTitle").textContent = `${title} · форма свернута`;
  $("#objDlg").close();
  $("#objDock").hidden = false;
};
$("#restoreObjBtn").onclick = () => {
  $("#objDock").hidden = true;
  $("#objDlg").showModal();
};
$("#pickBtn").onclick = () => { $("#objDlg").close(); picking = true; document.body.classList.add("picking"); toast("Нажмите на карте в нужном месте"); };
map.on("click", async e => {
  if (!picking) return;
  picking = false; document.body.classList.remove("picking");
  $("#oLat").value = e.latlng.lat.toFixed(6); $("#oLon").value = e.latlng.lng.toFixed(6);
  $("#oAddr").value = "";
  $("#objErr").textContent = "Ищем адрес по выбранной точке…";
  $("#objDock").hidden = true;
  $("#objDlg").showModal();
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ru&zoom=18&lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
    if (!response.ok) throw new Error("Не удалось определить адрес");
    const result = await response.json();
    const a = result.address || {};
    const city = a.city || a.town || a.village || a.municipality || a.county;
    const street = a.road || a.pedestrian || a.footway || a.residential || a.path;
    const house = a.house_number;
    const locality = a.hamlet || a.suburb || a.neighbourhood || a.island;
    const address = [city, street ? `${street}${house ? `, ${house}` : ""}` : locality]
      .filter(Boolean).join(", ");
    if (!address) throw new Error("Для этой точки адрес не найден — введите его вручную");
    $("#oAddr").value = address;
    $("#objErr").textContent = "";
  } catch (error) {
    $("#objErr").textContent = error.message || "Не удалось определить адрес — введите его вручную";
  }
});
$("#objForm").onsubmit = async e => {
  e.preventDefault();
  const from = $("#oHoursFrom").value, to = $("#oHoursTo").value;
  if (!!from !== !!to) { $("#objErr").textContent = "Укажите время открытия и закрытия"; return; }
  const body = {name: $("#oName").value, category_id: $("#oCat").value, address: $("#oAddr").value, description: $("#oDesc").value,
    phone: $("#oPhone").value, working_hours: from && to ? `${from}–${to}` : (editOriginalHours && !editOriginalHours.match(/\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}/) ? editOriginalHours : ""),
    lat: $("#oLat").value.replace(",", "."), lon: $("#oLon").value.replace(",", ".")};
  try {
    if (isAdmin()) { await api(editId ? "/api/objects/" + editId : "/api/objects", editId ? "PUT" : "POST", body); toast("Сохранено"); }
    else { await api("/api/requests", "POST", body); toast("Заявка отправлена администратору"); }
    $("#objDlg").close(); loadObjects(undefined, {preserveView: true});
  } catch (x) { $("#objErr").textContent = x.message; }
};

/* ---------- заявки ---------- */
const STATUS = {pending: "на рассмотрении", approved: "принята", rejected: "отклонена"};
async function openRequests() {
  $("#reqTitle").textContent = isAdmin() ? "Заявки пользователей" : "Мои заявки";
  const box = $("#reqList"); box.innerHTML = "";
  const items = await api("/api/requests");
  if (!items.length) box.innerHTML = `<p class="muted">Заявок пока нет.</p>`;
  items.forEach(r => {
    const d = document.createElement("div"); d.className = "req";
    d.innerHTML = `<b>${esc(r.name)}</b><small>${esc(catName(r.category_id))}, ${esc(r.address)}${isAdmin() ? " · от " + esc(r.user) : ""}</small>
      ${r.description ? `<p class="req-description">${esc(r.description)}</p>` : ""}
      ${r.phone ? `<small>Телефон: ${esc(r.phone)}</small>` : ""}${r.working_hours ? `<small>Часы работы: ${esc(r.working_hours)}</small>` : ""}
      <div class="status-${r.status}">${STATUS[r.status]}</div>`;
    if (isAdmin() && r.status === "pending") {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<button class="btn primary">Принять</button><button class="btn danger">Отклонить</button>`;
      const act = what => async () => {
        try { await api(`/api/requests/${r.id}/${what}`, "POST"); loadObjects(undefined, {preserveView: true}); }
        catch (x) { toast(x.message); }
        await openRequests();
      };
      row.children[0].onclick = act("approve"); row.children[1].onclick = act("reject"); d.append(row);
    }
    box.append(d);
  });
  if (!$("#reqDlg").open) $("#reqDlg").showModal();
}

/* ---------- поиск и фильтры ---------- */
function closeSearchSuggestions() {
  suggestionRequestId++;
  activeSuggestionIndex = -1;
  $("#searchSuggestions").hidden = true;
  $("#q").setAttribute("aria-expanded", "false");
}

async function updateSearchSuggestions() {
  const q = $("#q").value.trim();
  const requestId = ++suggestionRequestId;
  activeSuggestionIndex = -1;
  if (q.length < 2) return closeSearchSuggestions();

  const params = new URLSearchParams({q, categories: selectedCats().join(","), suggestions: "1"});
  try {
    const items = await api("/api/objects?" + params);
    if (requestId !== suggestionRequestId || $("#q").value.trim() !== q) return;

    const box = $("#searchSuggestions");
    box.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "search-suggestion-empty";
      empty.textContent = "Совпадений не найдено";
      box.append(empty);
    } else {
      items.forEach(o => {
        const option = document.createElement("li");
        option.className = "search-suggestion";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        const button = document.createElement("button");
        button.type = "button";
        const name = document.createElement("b"); name.textContent = o.name;
        const detail = document.createElement("span");
        detail.textContent = [catName(o.category_id), o.address].filter(Boolean).join(" · ");
        button.append(name, detail);
        button.addEventListener("click", () => selectSearchSuggestion(o));
        option.append(button);
        box.append(option);
      });
    }
    box.hidden = false;
    $("#q").setAttribute("aria-expanded", "true");
  } catch (_) {
    if (requestId === suggestionRequestId) closeSearchSuggestions();
  }
}

async function selectSearchSuggestion(o) {
  $("#q").value = o.name;
  closeSearchSuggestions();
  await loadObjects();
  const marker = markers[o.id];
  if (marker) { map.setView([o.lat, o.lon], 16); marker.openPopup(); }
}

function moveSuggestionSelection(direction) {
  const options = [...$("#searchSuggestions").querySelectorAll(".search-suggestion")];
  if (!options.length) return;
  activeSuggestionIndex = Math.max(0, Math.min(options.length - 1, activeSuggestionIndex + direction));
  options.forEach((option, index) => {
    const selected = index === activeSuggestionIndex;
    option.setAttribute("aria-selected", String(selected));
    if (selected) option.scrollIntoView({block: "nearest"});
  });
}

$("#q").addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  closeSearchSuggestions();
  suggestionTimer = setTimeout(updateSearchSuggestions, 220);
});
$("#q").addEventListener("keydown", e => {
  if (e.key === "ArrowDown" && !$("#searchSuggestions").hidden) {
    e.preventDefault(); moveSuggestionSelection(1);
  } else if (e.key === "ArrowUp" && !$("#searchSuggestions").hidden) {
    e.preventDefault(); moveSuggestionSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = $("#searchSuggestions").querySelector('[aria-selected="true"]');
    if (selected) selected.querySelector("button").click();
    else { closeSearchSuggestions(); loadObjects(); }
  } else if (e.key === "Escape") {
    closeSearchSuggestions();
  }
});
$("#q").addEventListener("blur", () => setTimeout(() => {
  if (!document.activeElement?.closest(".search-wrap")) closeSearchSuggestions();
}, 140));
$("#searchSuggestions").addEventListener("mousedown", e => e.preventDefault());
document.addEventListener("click", e => { if (!e.target.closest(".search-wrap")) closeSearchSuggestions(); });

$("#searchBtn").onclick = () => { closeSearchSuggestions(); loadObjects(); };
$("#resetBtn").onclick = () => { $("#q").value = ""; closeSearchSuggestions(); document.querySelectorAll("#cats input").forEach(i => i.checked = false); loadObjects(); map.setView([59.2187, 39.8886], 12); };

(async function start() {
  const [categoryData, currentUser, initialObjects] = await Promise.all([
    api("/api/categories"),
    api("/api/me"),
    api("/api/objects")
  ]);
  cats = categoryData;
  $("#cats").innerHTML = cats.map(c => `<label><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`).join("");
  $("#cats").onchange = () => { loadObjects(); if (!$("#searchSuggestions").hidden) updateSearchSuggestions(); };
  me = currentUser; renderNav(); loadObjects(initialObjects);
})();
