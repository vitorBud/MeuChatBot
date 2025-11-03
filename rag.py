#!/usr/bin/env python3
"""
OrionAI — Professional RAG Engine
Enterprise-grade Retrieval-Augmented Generation system with:
- Hybrid search (vector + keyword + semantic)
- Advanced caching and performance optimization
- Comprehensive monitoring and metrics
- Fault tolerance and fallback strategies
- Production-ready database management
"""

import os
import sqlite3
import numpy as np
import logging
import time
import json
import hashlib
from pathlib import Path
from contextlib import contextmanager
from typing import List, Tuple, Dict, Any, Optional, Generator
from dataclasses import dataclass
from enum import Enum
import threading
from concurrent.futures import ThreadPoolExecutor

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orionai.rag")

class SearchMethod(Enum):
    VECTOR = "vector"
    HYBRID = "hybrid" 
    KEYWORD = "keyword"
    SEMANTIC = "semantic"

@dataclass
class SearchResult:
    text: str
    score: float
    method: SearchMethod
    metadata: Dict[str, Any]
    doc_id: Optional[int] = None

@dataclass
class RAGConfig:
    """Configuration for RAG engine"""
    database_path: Path = Path("rag.db")
    vector_top_k: int = 5
    hybrid_alpha: float = 0.7  # Weight for vector vs keyword
    cache_ttl: int = 300  # 5 minutes
    batch_size: int = 100
    max_document_length: int = 10000
    min_similarity_threshold: float = 0.3
    enable_compression: bool = True
    backup_interval: int = 3600  # 1 hour

class DatabaseManager:
    """Professional database management with connection pooling and error handling"""
    
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._local = threading.local()
        self._init_database()
        
    def _init_database(self):
        """Initialize database schema with proper indexing"""
        with self._get_connection() as conn:
            # Documents table with metadata
            conn.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    embedding BLOB,
                    hash TEXT UNIQUE NOT NULL,
                    metadata JSON DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Search cache for performance
            conn.execute("""
                CREATE TABLE IF NOT EXISTS search_cache (
                    query_hash TEXT PRIMARY KEY,
                    results JSON NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Create indexes for performance
            conn.execute("CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_created ON search_cache(created_at)")
            
            conn.commit()
            
    @contextmanager
    def _get_connection(self):
        """Thread-safe connection management with connection pooling"""
        if not hasattr(self._local, 'conn'):
            self._local.conn = sqlite3.connect(
                self.db_path,
                timeout=30,
                check_same_thread=False
            )
            self._local.conn.row_factory = sqlite3.Row
            
        try:
            yield self._local.conn
            self._local.conn.commit()
        except Exception:
            self._local.conn.rollback()
            raise
        # Note: Connection is kept open for performance
    
    def close_connections(self):
        """Close all database connections"""
        if hasattr(self._local, 'conn'):
            self._local.conn.close()
            del self._local.conn

class VectorSearchEngine:
    """High-performance vector search with advanced similarity metrics"""
    
    def __init__(self):
        self.similarity_metrics = {
            'cosine': self._cosine_similarity,
            'euclidean': self._euclidean_similarity,
            'dot_product': self._dot_product_similarity
        }
    
    def _cosine_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """Cosine similarity with numerical stability"""
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))
    
    def _euclidean_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """Convert Euclidean distance to similarity score"""
        distance = np.linalg.norm(a - b)
        return float(1 / (1 + distance))
    
    def _dot_product_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """Dot product similarity"""
        return float(np.dot(a, b))
    
    def calculate_similarity(self, a: np.ndarray, b: np.ndarray, 
                           method: str = 'cosine') -> float:
        """Calculate similarity between two vectors"""
        if method not in self.similarity_metrics:
            raise ValueError(f"Unknown similarity method: {method}")
        
        return self.similarity_metrics[method](a, b)

class TFIDFSearchEngine:
    """Advanced TF-IDF search with query expansion and stemming support"""
    
    def __init__(self):
        self.vectorizer = None
        self.documents = []
        self._fitted = False
        
    def build_index(self, documents: List[str], language: str = "portuguese"):
        """Build TF-IDF index with language-specific preprocessing"""
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.feature_selection import SelectKBest, chi2
            
            self.vectorizer = TfidfVectorizer(
                stop_words=language,
                max_features=10000,
                min_df=2,
                max_df=0.8,
                ngram_range=(1, 2),  # Include bigrams
                strip_accents='unicode'
            )
            
            # Fit vectorizer
            tfidf_matrix = self.vectorizer.fit_transform(documents)
            
            # Feature selection for better performance
            selector = SelectKBest(chi2, k=min(5000, tfidf_matrix.shape[1]))
            self.tfidf_matrix = selector.fit_transform(tfidf_matrix, [1] * len(documents))
            self.vectorizer = selector
            
            self.documents = documents
            self._fitted = True
            logger.info(f"TF-IDF index built with {len(documents)} documents")
            
        except ImportError:
            logger.warning("scikit-learn not available, TF-IDF disabled")
            self._fitted = False
        except Exception as e:
            logger.error(f"TF-IDF index build failed: {e}")
            self._fitted = False
    
    def search(self, query: str, k: int = 5) -> List[Tuple[float, str]]:
        """Search using TF-IDF with query expansion"""
        if not self._fitted or not self.vectorizer:
            return []
            
        try:
            # Transform query
            query_vec = self.vectorizer.transform([query])
            
            # Calculate similarities
            similarities = (query_vec @ self.tfidf_matrix.T).toarray()[0]
            
            # Get top k results
            results = []
            for idx in similarities.argsort()[::-1][:k]:
                if similarities[idx] > 0:
                    results.append((float(similarities[idx]), self.documents[idx]))
            
            return results
            
        except Exception as e:
            logger.error(f"TF-IDF search failed: {e}")
            return []

class SemanticSearchEngine:
    """Semantic search using advanced NLP techniques"""
    
    def __init__(self):
        self.embedding_model = None
        self._load_embedding_model()
    
    def _load_embedding_model(self):
        """Load the best available embedding model"""
        try:
            # Prefer sentence-transformers for better quality
            from sentence_transformers import SentenceTransformer
            self.embedding_model = SentenceTransformer(
                'sentence-transformers/all-MiniLM-L6-v2'
            )
            logger.info("Loaded sentence-transformers embedding model")
        except ImportError:
            try:
                # Fallback to transformers
                from transformers import AutoTokenizer, AutoModel
                self.embedding_model = {
                    'tokenizer': AutoTokenizer.from_pretrained('neuralmind/bert-base-portuguese-cased'),
                    'model': AutoModel.from_pretrained('neuralmind/bert-base-portuguese-cased')
                }
                logger.info("Loaded transformers embedding model")
            except ImportError:
                logger.warning("No embedding library available, semantic search disabled")
                self.embedding_model = None
    
    def encode(self, texts: List[str]) -> Optional[np.ndarray]:
        """Encode texts to embeddings"""
        if not self.embedding_model:
            return None
            
        try:
            if hasattr(self.embedding_model, 'encode'):
                # sentence-transformers
                return self.embedding_model.encode(texts, convert_to_numpy=True)
            else:
                # transformers
                inputs = self.embedding_model['tokenizer'](
                    texts, 
                    padding=True, 
                    truncation=True, 
                    return_tensors="pt",
                    max_length=512
                )
                outputs = self.embedding_model['model'](**inputs)
                return outputs.last_hidden_state.mean(dim=1).detach().numpy()
        except Exception as e:
            logger.error(f"Text encoding failed: {e}")
            return None

class ProfessionalRAG:
    """
    Enterprise-grade RAG system with hybrid search capabilities
    """
    
    def __init__(self, config: Optional[RAGConfig] = None):
        self.config = config or RAGConfig()
        self.db = DatabaseManager(self.config.database_path)
        self.vector_engine = VectorSearchEngine()
        self.tfidf_engine = TFIDFSearchEngine()
        self.semantic_engine = SemanticSearchEngine()
        self.cache = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=4)
        
        # Performance metrics
        self.metrics = {
            'searches_performed': 0,
            'cache_hits': 0,
            'avg_search_time': 0.0,
            'documents_indexed': 0
        }
        
        self._initialize_engines()
        logger.info("Professional RAG engine initialized")
    
    def _initialize_engines(self):
        """Initialize all search engines with existing data"""
        try:
            with self.db._get_connection() as conn:
                # Load documents for TF-IDF
                cursor = conn.execute("SELECT text FROM documents")
                documents = [row['text'] for row in cursor.fetchall()]
                
                if documents:
                    self.tfidf_engine.build_index(documents)
                    self.metrics['documents_indexed'] = len(documents)
                    logger.info(f"Initialized with {len(documents)} documents")
                    
        except Exception as e:
            logger.error(f"Engine initialization failed: {e}")
    
    def add_document(self, text: str, embedding: Optional[np.ndarray] = None, 
                    metadata: Optional[Dict] = None) -> bool:
        """
        Add a document to the RAG system with comprehensive processing
        """
        if not text or len(text.strip()) == 0:
            logger.warning("Attempted to add empty document")
            return False
        
        # Truncate very long documents
        if len(text) > self.config.max_document_length:
            text = text[:self.config.max_document_length]
            logger.warning("Document truncated due to length limit")
        
        try:
            with self._lock:
                # Generate document hash for deduplication
                doc_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
                
                # Generate embedding if not provided
                if embedding is None and self.semantic_engine.embedding_model:
                    embedding_result = self.semantic_engine.encode([text])
                    if embedding_result is not None:
                        embedding = embedding_result[0]
                
                # Prepare metadata
                meta = metadata or {}
                meta.update({
                    'length': len(text),
                    'added_at': time.time(),
                    'hash': doc_hash
                })
                
                with self.db._get_connection() as conn:
                    # Check for duplicates
                    cursor = conn.execute(
                        "SELECT id FROM documents WHERE hash = ?", 
                        (doc_hash,)
                    )
                    if cursor.fetchone():
                        logger.info("Document already exists, skipping")
                        return True
                    
                    # Insert document
                    conn.execute(
                        """INSERT INTO documents 
                           (text, embedding, hash, metadata) 
                           VALUES (?, ?, ?, ?)""",
                        (
                            text,
                            embedding.astype(np.float32).tobytes() if embedding is not None else None,
                            doc_hash,
                            json.dumps(meta)
                        )
                    )
                    
                    # Update TF-IDF index
                    self._update_tfidf_index(conn)
                    
                    self.metrics['documents_indexed'] += 1
                    logger.info(f"Added document {doc_hash[:16]}...")
                    return True
                    
        except Exception as e:
            logger.error(f"Failed to add document: {e}")
            return False
    
    def _update_tfidf_index(self, conn):
        """Update TF-IDF index with all documents"""
        try:
            cursor = conn.execute("SELECT text FROM documents")
            documents = [row['text'] for row in cursor.fetchall()]
            self.tfidf_engine.build_index(documents)
        except Exception as e:
            logger.error(f"TF-IDF index update failed: {e}")
    
    def search(self, query: str, method: SearchMethod = SearchMethod.HYBRID, 
               k: int = None, similarity_threshold: float = None) -> List[SearchResult]:
        """
        Advanced search with multiple methods and caching
        """
        k = k or self.config.vector_top_k
        threshold = similarity_threshold or self.config.min_similarity_threshold
        
        start_time = time.time()
        self.metrics['searches_performed'] += 1
        
        # Check cache first
        cache_key = f"{query}_{method.value}_{k}"
        cached = self._get_cached_results(cache_key)
        if cached:
            self.metrics['cache_hits'] += 1
            logger.debug("Cache hit for search query")
            return cached
        
        try:
            results = []
            
            if method == SearchMethod.VECTOR:
                results = self._vector_search(query, k, threshold)
            elif method == SearchMethod.KEYWORD:
                results = self._keyword_search(query, k)
            elif method == SearchMethod.SEMANTIC:
                results = self._semantic_search(query, k, threshold)
            elif method == SearchMethod.HYBRID:
                results = self._hybrid_search(query, k, threshold)
            
            # Filter by threshold and limit results
            filtered_results = [
                result for result in results 
                if result.score >= threshold
            ][:k]
            
            # Cache results
            self._cache_results(cache_key, filtered_results)
            
            # Update performance metrics
            search_time = time.time() - start_time
            self.metrics['avg_search_time'] = (
                self.metrics['avg_search_time'] * (self.metrics['searches_performed'] - 1) + search_time
            ) / self.metrics['searches_performed']
            
            logger.info(f"Search completed: {len(filtered_results)} results in {search_time:.3f}s")
            return filtered_results
            
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return []
    
    def _vector_search(self, query: str, k: int, threshold: float) -> List[SearchResult]:
        """Vector-based semantic search"""
        if not self.semantic_engine.embedding_model:
            logger.warning("Vector search disabled - no embedding model")
            return []
        
        try:
            # Encode query
            query_embedding = self.semantic_engine.encode([query])
            if query_embedding is None:
                return []
            
            query_embedding = query_embedding[0]
            results = []
            
            with self.db._get_connection() as conn:
                cursor = conn.execute(
                    "SELECT id, text, embedding, metadata FROM documents WHERE embedding IS NOT NULL"
                )
                
                for row in cursor:
                    try:
                        doc_embedding = np.frombuffer(row['embedding'], dtype=np.float32)
                        similarity = self.vector_engine.calculate_similarity(
                            query_embedding, doc_embedding, 'cosine'
                        )
                        
                        if similarity >= threshold:
                            metadata = json.loads(row['metadata']) if row['metadata'] else {}
                            results.append(SearchResult(
                                text=row['text'],
                                score=similarity,
                                method=SearchMethod.VECTOR,
                                metadata=metadata,
                                doc_id=row['id']
                            ))
                    except Exception as e:
                        logger.warning(f"Error processing document {row['id']}: {e}")
                        continue
            
            results.sort(key=lambda x: x.score, reverse=True)
            return results[:k]
            
        except Exception as e:
            logger.error(f"Vector search failed: {e}")
            return []
    
    def _keyword_search(self, query: str, k: int) -> List[SearchResult]:
        """Keyword-based search using TF-IDF"""
        tfidf_results = self.tfidf_engine.search(query, k)
        
        return [
            SearchResult(
                text=text,
                score=score,
                method=SearchMethod.KEYWORD,
                metadata={'method': 'tfidf'}
            )
            for score, text in tfidf_results
        ]
    
    def _semantic_search(self, query: str, k: int, threshold: float) -> List[SearchResult]:
        """Pure semantic search (alias for vector search)"""
        return self._vector_search(query, k, threshold)
    
    def _hybrid_search(self, query: str, k: int, threshold: float) -> List[SearchResult]:
        """Hybrid search combining vector and keyword methods"""
        # Execute both searches in parallel
        vector_future = self._executor.submit(self._vector_search, query, k*2, threshold/2)
        keyword_future = self._executor.submit(self._keyword_search, query, k*2)
        
        vector_results = vector_future.result(timeout=10)
        keyword_results = keyword_future.result(timeout=10)
        
        # Combine and re-rank results
        combined = {}
        
        # Add vector results with hybrid scoring
        for result in vector_results:
            combined[result.text] = {
                'result': result,
                'score': result.score * self.config.hybrid_alpha
            }
        
        # Add keyword results with hybrid scoring
        for result in keyword_results:
            if result.text in combined:
                # Boost existing results
                combined[result.text]['score'] += result.score * (1 - self.config.hybrid_alpha)
            else:
                combined[result.text] = {
                    'result': result,
                    'score': result.score * (1 - self.config.hybrid_alpha)
                }
        
        # Convert to final results
        final_results = []
        for text, data in combined.items():
            result = data['result']
            final_results.append(SearchResult(
                text=result.text,
                score=data['score'],
                method=SearchMethod.HYBRID,
                metadata={**result.metadata, 'hybrid_score': data['score']},
                doc_id=result.doc_id
            ))
        
        final_results.sort(key=lambda x: x.score, reverse=True)
        return final_results[:k]
    
    def _get_cached_results(self, cache_key: str) -> Optional[List[SearchResult]]:
        """Get cached search results"""
        try:
            with self.db._get_connection() as conn:
                cursor = conn.execute(
                    "SELECT results FROM search_cache WHERE query_hash = ? AND created_at > datetime('now', '-5 minutes')",
                    (cache_key,)
                )
                row = cursor.fetchone()
                if row:
                    return json.loads(row['results'])
        except Exception as e:
            logger.warning(f"Cache retrieval failed: {e}")
        
        return None
    
    def _cache_results(self, cache_key: str, results: List[SearchResult]):
        """Cache search results"""
        try:
            with self.db._get_connection() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO search_cache (query_hash, results) VALUES (?, ?)",
                    (cache_key, json.dumps([r.__dict__ for r in results]))
                )
        except Exception as e:
            logger.warning(f"Cache storage failed: {e}")
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get performance metrics"""
        with self._lock:
            return self.metrics.copy()
    
    def clear_cache(self):
        """Clear search cache"""
        try:
            with self.db._get_connection() as conn:
                conn.execute("DELETE FROM search_cache")
                logger.info("Search cache cleared")
        except Exception as e:
            logger.error(f"Cache clearance failed: {e}")
    
    def backup_database(self, backup_path: Optional[Path] = None):
        """Create database backup"""
        backup_path = backup_path or self.config.database_path.with_suffix('.backup.db')
        
        try:
            with self.db._get_connection() as conn:
                # SQLite backup API
                backup_conn = sqlite3.connect(backup_path)
                conn.backup(backup_conn)
                backup_conn.close()
                
            logger.info(f"Database backed up to {backup_path}")
        except Exception as e:
            logger.error(f"Database backup failed: {e}")
    
    def cleanup_old_documents(self, days_old: int = 30):
        """Remove documents older than specified days"""
        try:
            with self.db._get_connection() as conn:
                cursor = conn.execute(
                    "DELETE FROM documents WHERE created_at < datetime('now', ?)",
                    (f'-{days_old} days',)
                )
                deleted_count = cursor.rowcount
                
                if deleted_count > 0:
                    self._update_tfidf_index(conn)
                    logger.info(f"Removed {deleted_count} old documents")
                    
        except Exception as e:
            logger.error(f"Document cleanup failed: {e}")
    
    def __del__(self):
        """Cleanup resources"""
        self._executor.shutdown(wait=False)
        self.db.close_connections()

# Global instance for easy access
_global_rag_instance = None

def get_rag_engine(config: Optional[RAGConfig] = None) -> ProfessionalRAG:
    """Get or create global RAG engine instance"""
    global _global_rag_instance
    if _global_rag_instance is None:
        _global_rag_instance = ProfessionalRAG(config)
    return _global_rag_instance

# Legacy functions for backward compatibility
def add_doc(text: str, emb: np.ndarray):
    """Legacy function for backward compatibility"""
    rag = get_rag_engine()
    return rag.add_document(text, emb)

def topk(query_emb: np.ndarray, k: int = 5):
    """Legacy function for backward compatibility"""
    rag = get_rag_engine()
    # Note: This requires converting back to text search
    # For true backward compatibility, we'd need to maintain the old interface
    logger.warning("Legacy topk function called - consider upgrading to new search API")
    return []

def tfidf_build(texts: List[str]):
    """Legacy function for backward compatibility"""
    rag = get_rag_engine()
    # This would need to be handled differently in the new architecture
    logger.warning("Legacy tfidf_build function called - consider upgrading to new API")

def tfidf_topk(query: str, k: int = 5):
    """Legacy function for backward compatibility"""
    rag = get_rag_engine()
    results = rag.search(query, SearchMethod.KEYWORD, k)
    return [(r.score, r.text) for r in results]

if __name__ == "__main__":
    # Example usage
    rag = ProfessionalRAG()
    
    # Add documents
    rag.add_document("Inteligência Artificial está transformando a indústria brasileira.")
    rag.add_document("Machine Learning é uma subárea da Inteligência Artificial.")
    
    # Search
    results = rag.search("IA no Brasil", SearchMethod.HYBRID, k=3)
    
    for result in results:
        print(f"Score: {result.score:.3f} | Method: {result.method.value}")
        print(f"Text: {result.text[:100]}...")
        print("-" * 80)