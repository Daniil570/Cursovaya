import os, re
from datetime import datetime, timezone
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import Flask, jsonify, request, session, render_template
from pymongo import MongoClient, GEOSPHERE
from pymongo.errors import DuplicateKeyError
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
DEBUG = os.environ.get("FLASK_DEBUG") == "1"
app.secret_key = os.environ.get("SECRET_KEY") or ("dev-only-change-me" if DEBUG else None)
if not app.secret_key:
    raise RuntimeError("Не задана переменная окружения SECRET_KEY")
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1")

db = MongoClient(os.environ.get("MONGO_URI", "mongodb://localhost:27017/"))[
    os.environ.get("MONGO_DB", "citymap")]
users, categories, objects, requests_col = (
    db["users"], db["categories"], db["objects"], db["object_requests"])

users.create_index("email", unique=True)
users.create_index("username", unique=True)
objects.create_index([("location", GEOSPHERE)])
objects.create_index("category_id")
requests_col.create_index([("user_id", 1), ("created_at", -1)])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+7-\d{3}-\d{3}-\d{2}-\d{2}$")


def now():
    return datetime.now(timezone.utc)


def err(msg, code=400):
    return jsonify({"error": msg}), code


def text(value):
    return "" if value is None else str(value).strip()


def to_oid(value):
    if value is None:
        return None
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def public_object(o):
    lon, lat = o["location"]["coordinates"]
    return {"id": str(o["_id"]), "name": o["name"], "category_id": str(o["category_id"]),
            "description": o.get("description", ""), "address": o.get("address", ""),
            "phone": o.get("phone", ""), "working_hours": o.get("working_hours", ""),
            "lat": lat, "lon": lon}


def public_request(r, username=None):
    d = public_object(r)
    if username is None:
        username = (users.find_one({"_id": r["user_id"]}) or {}).get("username", "?")
    d.update(status=r["status"], created_at=r["created_at"].isoformat(), user=username)
    return d


def validate_object(data):
    if not isinstance(data, dict):
        return None, "Нет данных"
    name = text(data.get("name"))
    address = text(data.get("address"))
    if not name or len(name) > 150:
        return None, "Название обязательно (до 150 символов)"
    if not address:
        return None, "Адрес обязателен"
    if len(address) > 250:
        return None, "Адрес слишком длинный (до 250 символов)"
    cat = to_oid(data.get("category_id"))
    if not cat or not categories.find_one({"_id": cat}):
        return None, "Выберите существующую категорию"
    try:
        lat, lon = float(data.get("lat")), float(data.get("lon"))
    except (TypeError, ValueError):
        return None, "Координаты должны быть числами"
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, "Координаты вне допустимого диапазона"
    phone = text(data.get("phone"))
    if phone:
        digits = re.sub(r"\D", "", phone)
        if len(digits) == 11 and digits[0] in "78":
            digits = digits[1:]
        if len(digits) != 10:
            return None, "Телефон должен содержать 10 цифр после +7"
        phone = f"+7-{digits[:3]}-{digits[3:6]}-{digits[6:8]}-{digits[8:10]}"
        if not PHONE_RE.match(phone):
            return None, "Некорректный телефон"
    description = text(data.get("description"))
    hours = text(data.get("working_hours"))
    if len(description) > 2000:
        return None, "Описание слишком длинное (до 2000 символов)"
    if len(hours) > 100:
        return None, "Часы работы: не более 100 символов"
    return {"name": name, "address": address, "category_id": cat,
            "description": description, "phone": phone, "working_hours": hours,
            "location": {"type": "Point", "coordinates": [lon, lat]}}, None


def login_required(f):
    @wraps(f)
    def wrap(*a, **kw):
        if "user_id" not in session:
            return err("Требуется вход", 401)
        return f(*a, **kw)
    return wrap


def admin_required(f):
    @wraps(f)
    @login_required
    def wrap(*a, **kw):
        if session.get("role") != "administrator":
            return err("Недостаточно прав", 403)
        return f(*a, **kw)
    return wrap

@app.route("/")
def index():
    return render_template("index.html")


@app.get("/privacy")
def privacy():
    return render_template("privacy.html")


@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    username = text(d.get("username"))
    email = text(d.get("email")).lower()
    password = "" if d.get("password") is None else str(d.get("password"))
    if not 3 <= len(username) <= 30:
        return err("Имя пользователя: от 3 до 30 символов")
    if "@" in username:
        return err("Имя пользователя не должно содержать «@»")
    if not EMAIL_RE.match(email):
        return err("Некорректная почта")
    if len(password) < 6:
        return err("Пароль: минимум 6 символов")
    if users.find_one({"$or": [{"email": email}, {"username": username}]}):
        return err("Такой пользователь или почта уже есть", 409)
    try:
        uid = users.insert_one({"username": username, "email": email,
                                "password_hash": generate_password_hash(password),
                                "role": "user", "created_at": now()}).inserted_id
    except DuplicateKeyError:  # гонка двух одновременных регистраций
        return err("Такой пользователь или почта уже есть", 409)
    session.update(user_id=str(uid), role="user", username=username)
    return jsonify({"username": username, "role": "user"}), 201


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    login_ = text(d.get("username"))
    u = users.find_one({"$or": [{"username": login_}, {"email": login_.lower()}]})
    if not u or not check_password_hash(u["password_hash"], "" if d.get("password") is None else str(d.get("password"))):
        return err("Неверное имя или пароль", 401)
    session.update(user_id=str(u["_id"]), role=u["role"], username=u["username"])
    return jsonify({"username": u["username"], "role": u["role"]})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    if "user_id" not in session:
        return jsonify(None)
    return jsonify({"username": session["username"], "role": session["role"]})


@app.get("/api/categories")
def list_categories():
    return jsonify([{"id": str(c["_id"]), "name": c["name"], "description": c.get("description", "")}
                    for c in categories.find().sort("name")])


@app.get("/api/objects")
def list_objects():
    query = {}
    q = request.args.get("q", "").strip()
    if q:
        words = q.split()
        query["$and"] = [
            {"$or": [
                {"name": {"$regex": re.escape(word), "$options": "i"}},
                {"address": {"$regex": re.escape(word), "$options": "i"}}
            ]}
            for word in words
        ]
    ids = [to_oid(i) for i in request.args.get("categories", "").split(",") if i]
    if None in ids:
        return err("Некорректный идентификатор категории")
    if ids:
        query["category_id"] = {"$in": ids}
    projection = {
        "name": 1,
        "category_id": 1,
        "description": 1,
        "address": 1,
        "phone": 1,
        "working_hours": 1,
        "location": 1,
    }
    found = list(objects.find(query, projection))
    if request.args.get("suggestions") == "1":
        words = [word.casefold() for word in q.split()]
        found.sort(key=lambda o: (
            -sum(any((o.get(field) or "").casefold().startswith(word)
                     for field in ("name", "address")) for word in words),
            (o.get("name") or "").casefold()
        ))
        found = found[:8]
    return jsonify([public_object(o) for o in found])


@app.post("/api/objects")
@admin_required
def create_object():
    clean, e = validate_object(request.get_json(silent=True))
    if e:
        return err(e)
    clean.update(created_at=now(), updated_at=now())
    clean["_id"] = objects.insert_one(clean).inserted_id
    return jsonify(public_object(clean)), 201


@app.put("/api/objects/<oid>")
@admin_required
def update_object(oid):
    _id = to_oid(oid)
    if not _id or not objects.find_one({"_id": _id}):
        return err("Объект не найден", 404)
    clean, e = validate_object(request.get_json(silent=True))
    if e:
        return err(e)
    clean["updated_at"] = now()
    objects.update_one({"_id": _id}, {"$set": clean})
    return jsonify(public_object(objects.find_one({"_id": _id})))


@app.delete("/api/objects/<oid>")
@admin_required
def delete_object(oid):
    _id = to_oid(oid)
    if not _id or objects.delete_one({"_id": _id}).deleted_count == 0:
        return err("Объект не найден", 404)
    return jsonify({"ok": True})


@app.post("/api/requests")
@login_required
def create_request():
    clean, e = validate_object(request.get_json(silent=True))
    if e:
        return err(e)
    clean.update(user_id=to_oid(session["user_id"]), status="pending", created_at=now(),
                 processed_at=None, processed_by=None)
    clean["_id"] = requests_col.insert_one(clean).inserted_id
    return jsonify(public_request(clean, session["username"])), 201


@app.get("/api/requests")
@login_required
def list_requests():
    query = {} if session["role"] == "administrator" else {"user_id": to_oid(session["user_id"])}
    items = list(requests_col.find(query).sort("created_at", -1))
    ids = list({r["user_id"] for r in items})
    names = {u["_id"]: u["username"] for u in users.find({"_id": {"$in": ids}}, {"username": 1})}
    return jsonify([public_request(r, names.get(r["user_id"], "?")) for r in items])


def process_request(rid, status):
    _id = to_oid(rid)
    if not _id or not requests_col.find_one({"_id": _id}, {"_id": 1}):
        return err("Заявка не найдена", 404)
    # атомарный переход pending -> status: параллельный вызов получит None
    r = requests_col.find_one_and_update(
        {"_id": _id, "status": "pending"},
        {"$set": {"status": status, "processed_at": now(),
                  "processed_by": to_oid(session["user_id"])}})
    if r is None:
        return err("Заявка уже обработана", 409)
    if status == "approved":
        objects.insert_one({k: r[k] for k in ("name", "category_id", "description", "address",
                            "location", "phone", "working_hours")} | {"created_at": now(), "updated_at": now()})
    return jsonify({"ok": True, "status": status})


@app.post("/api/requests/<rid>/approve")
@admin_required
def approve(rid):
    return process_request(rid, "approved")


@app.post("/api/requests/<rid>/reject")
@admin_required
def reject(rid):
    return process_request(rid, "rejected")


if __name__ == "__main__":
    app.run(debug=DEBUG)
