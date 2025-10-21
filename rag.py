# rag.py
import os, sqlite3, numpy as np
from pathlib import Path
from contextlib import closing
from typing import List, Tuple

DB = Path("rag.db")

def _conn():
    con = sqlite3.connect(DB)
    con.execute("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, text TEXT, emb BLOB)")
    return con

def add_doc(text:str, emb:np.ndarray):
    with closing(_conn()) as con:
        con.execute("INSERT INTO docs(text, emb) VALUES(?,?)", (text, emb.astype(np.float32).tobytes()))
        con.commit()

def all_rows():
    with closing(_conn()) as con:
        cur = con.execute("SELECT id, text, emb FROM docs")
        return cur.fetchall()

def cos(a,b): return float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)+1e-8))

def topk(query_emb: np.ndarray, k=5) -> List[Tuple[float,str]]:
    rows = all_rows()
    scored=[]
    for _id, text, emb_blob in rows:
        emb = np.frombuffer(emb_blob, dtype=np.float32)
        scored.append((cos(query_emb, emb), text))
    scored.sort(reverse=True, key=lambda x: x[0])
    return scored[:k]

# Fallback TF-IDF (se embeddings indisponíveis)
from sklearn.feature_extraction.text import TfidfVectorizer
_vec = None
_docs = []

def tfidf_build(texts:List[str]):
    global _vec, _docs
    _docs = texts[:]
    _vec = TfidfVectorizer(stop_words="portuguese").fit(_docs)

def tfidf_topk(query:str, k=5):
    if not _vec or not _docs: return []
    qv = _vec.transform([query])
    dv = _vec.transform(_docs)
    scores = (qv @ dv.T).toarray()[0]
    idx = scores.argsort()[::-1][:k]
    return [(float(scores[i]), _docs[i]) for i in idx]
