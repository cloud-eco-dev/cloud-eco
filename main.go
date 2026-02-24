package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/mux"
	"github.com/rs/cors"
)

const (
	Port           = ":8080"
	UploadsDir     = "uploads"
	MaxFileSize    = 100 << 20          // 100 MB
	JWTSecret      = "super-secret-key-2026-change-me" // В продакшене — из .env или секрет
	TokenDuration  = 24 * time.Hour
	DefaultMaxSize = 5 * 1024 * 1024 * 1024 // 5 GB на пользователя
)

type User struct {
	UID      string `json:"uid"`
	Email    string `json:"email"`
	Password string `json:"-"` // в продакшене — bcrypt-хеш
}

type FileInfo struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	IsDir    bool      `json:"isDir"`
	Modified time.Time `json:"modified"`
}

type Response struct {
	Success bool        `json:"success"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type SpaceInfo struct {
	Used     int64   `json:"used"`
	Max      int64   `json:"max"`
	UsedGB   float64 `json:"usedGB"`
	MaxGB    float64 `json:"maxGB"`
	Percent  float64 `json:"percent"`
}

type ShareLink struct {
	ID         string    `json:"id"`
	Path       string    `json:"path"`
	OwnerUID   string    `json:"ownerUid"`
	CreatedAt  time.Time `json:"createdAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Permission string    `json:"permission"` // "read" или "write"
	Token      string    `json:"token"`
}

var (
	users      = make(map[string]User) // email → user
	shareLinks = make(map[string]ShareLink)
	mu         = &sync.RWMutex{}
)

// ========================================
// Утилиты
// ========================================

func generateToken(length int) string {
	b := make([]byte, length)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func generateJWT(uid string) (string, error) {
	claims := jwt.MapClaims{
		"uid": uid,
		"exp": time.Now().Add(TokenDuration).Unix(),
		"iat": time.Now().Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(JWTSecret))
}

func getSafePath(uid, requestedPath string) (string, error) {
	clean := filepath.Clean("/" + strings.TrimPrefix(requestedPath, "/"))
	if strings.HasPrefix(clean, "..") || strings.Contains(clean, "../") {
		return "", fmt.Errorf("path traversal attempt")
	}
	return filepath.Join(UploadsDir, uid, clean[1:]), nil
}

func calculateDirSize(dir string) (int64, error) {
	var size int64
	err := filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size, err
}

func jsonResponse(w http.ResponseWriter, resp Response, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

// ========================================
// Middleware аутентификации
// ========================================

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			jsonResponse(w, Response{Success: false, Error: "Unauthorized"}, http.StatusUnauthorized)
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(JWTSecret), nil
		}, jwt.WithValidMethods([]string{"HS256"}))

		if err != nil || !token.Valid {
			jsonResponse(w, Response{Success: false, Error: "Invalid token"}, http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			jsonResponse(w, Response{Success: false, Error: "Invalid claims"}, http.StatusUnauthorized)
			return
		}

		uid, ok := claims["uid"].(string)
		if !ok {
			jsonResponse(w, Response{Success: false, Error: "Invalid user"}, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), "uid", uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ========================================
// Аутентификация
// ========================================

func registerHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid request"}, http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" {
		jsonResponse(w, Response{Success: false, Error: "Email and password required"}, http.StatusBadRequest)
		return
	}

	mu.Lock()
	defer mu.Unlock()

	if _, exists := users[req.Email]; exists {
		jsonResponse(w, Response{Success: false, Error: "User already exists"}, http.StatusConflict)
		return
	}

	uid := generateToken(16)
	users[req.Email] = User{
		UID:      uid,
		Email:    req.Email,
		Password: req.Password, // В продакшене заменить на bcrypt
	}

	token, err := generateJWT(uid)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to generate token"}, http.StatusInternalServerError)
		return
	}

	jsonResponse(w, Response{
		Success: true,
		Data:    map[string]string{"token": token, "uid": uid},
	}, http.StatusCreated)
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid request"}, http.StatusBadRequest)
		return
	}

	mu.RLock()
	user, exists := users[req.Email]
	mu.RUnlock()

	if !exists || user.Password != req.Password {
		jsonResponse(w, Response{Success: false, Error: "Invalid credentials"}, http.StatusUnauthorized)
		return
	}

	token, err := generateJWT(user.UID)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to generate token"}, http.StatusInternalServerError)
		return
	}

	jsonResponse(w, Response{
		Success: true,
		Data:    map[string]string{"token": token, "uid": user.UID},
	}, http.StatusOK)
}

// ========================================
// Файловые операции
// ========================================

func listFilesHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	fullPath, err := getSafePath(uid, path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid path"}, http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		_ = os.MkdirAll(fullPath, 0755)
		jsonResponse(w, Response{Success: true, Data: []FileInfo{}}, http.StatusOK)
		return
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot read directory"}, http.StatusInternalServerError)
		return
	}

	var files []FileInfo
	for _, entry := range entries {
		info, _ := entry.Info()
		relPath := filepath.Join(path, entry.Name())
		if path == "/" {
			relPath = "/" + entry.Name()
		}
		files = append(files, FileInfo{
			Name:     entry.Name(),
			Path:     relPath,
			Size:     info.Size(),
			IsDir:    entry.IsDir(),
			Modified: info.ModTime(),
		})
	}

	jsonResponse(w, Response{Success: true, Data: files}, http.StatusOK)
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	fullPath, err := getSafePath(uid, path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid path"}, http.StatusBadRequest)
		return
	}

	err = r.ParseMultipartForm(MaxFileSize)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "File too large or bad form"}, http.StatusBadRequest)
		return
	}

	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		jsonResponse(w, Response{Success: false, Error: "No files"}, http.StatusBadRequest)
		return
	}

	_ = os.MkdirAll(fullPath, 0755)

	var uploaded []string
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			continue
		}
		defer f.Close()

		dest := filepath.Join(fullPath, fh.Filename)
		if _, err := os.Stat(dest); err == nil {
			ext := filepath.Ext(fh.Filename)
			base := strings.TrimSuffix(fh.Filename, ext)
			i := 1
			for {
				newName := fmt.Sprintf("%s (%d)%s", base, i, ext)
				newDest := filepath.Join(fullPath, newName)
				if _, err := os.Stat(newDest); os.IsNotExist(err) {
					dest = newDest
					break
				}
				i++
			}
		}

		dst, err := os.Create(dest)
		if err != nil {
			continue
		}
		defer dst.Close()

		_, err = io.Copy(dst, f)
		if err != nil {
			continue
		}

		uploaded = append(uploaded, fh.Filename)
	}

	jsonResponse(w, Response{
		Success: true,
		Message: fmt.Sprintf("Uploaded %d files", len(uploaded)),
		Data:    uploaded,
	}, http.StatusOK)
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	vars := mux.Vars(r)
	path := vars["path"]

	fullPath, err := getSafePath(uid, path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid path"}, http.StatusBadRequest)
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "File not found"}, http.StatusNotFound)
		return
	}
	if info.IsDir() {
		jsonResponse(w, Response{Success: false, Error: "Cannot download directory"}, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Disposition", "attachment; filename="+filepath.Base(fullPath))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	http.ServeFile(w, r, fullPath)
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	vars := mux.Vars(r)
	path := vars["path"]

	fullPath, err := getSafePath(uid, path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid path"}, http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonResponse(w, Response{Success: false, Error: "Not found"}, http.StatusNotFound)
		return
	}

	err = os.RemoveAll(fullPath)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to delete"}, http.StatusInternalServerError)
		return
	}

	jsonResponse(w, Response{Success: true, Message: "Deleted successfully"}, http.StatusOK)
}

func mkdirHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid request"}, http.StatusBadRequest)
		return
	}

	base, err := getSafePath(uid, req.Path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid base path"}, http.StatusBadRequest)
		return
	}

	target := filepath.Join(base, req.Name)
	if _, err := os.Stat(target); err == nil {
		jsonResponse(w, Response{Success: false, Error: "Directory already exists"}, http.StatusConflict)
		return
	}

	err = os.MkdirAll(target, 0755)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to create directory"}, http.StatusInternalServerError)
		return
	}

	jsonResponse(w, Response{Success: true, Message: "Directory created"}, http.StatusCreated)
}

func spaceHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	userDir := filepath.Join(UploadsDir, uid)

	if _, err := os.Stat(userDir); os.IsNotExist(err) {
		jsonResponse(w, Response{Success: true, Data: SpaceInfo{
			Used:    0,
			Max:     DefaultMaxSize,
			UsedGB:  0,
			MaxGB:   float64(DefaultMaxSize) / (1 << 30),
			Percent: 0,
		}}, http.StatusOK)
		return
	}

	used, err := calculateDirSize(userDir)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to calculate space"}, http.StatusInternalServerError)
		return
	}

	percent := float64(used) / float64(DefaultMaxSize) * 100
	jsonResponse(w, Response{Success: true, Data: SpaceInfo{
		Used:    used,
		Max:     DefaultMaxSize,
		UsedGB:  float64(used) / (1 << 30),
		MaxGB:   float64(DefaultMaxSize) / (1 << 30),
		Percent: percent,
	}}, http.StatusOK)
}

func main() {
	os.MkdirAll(UploadsDir, 0755)

	r := mux.NewRouter()

	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"}, 
		AllowedMethods:   []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	})

	r.HandleFunc("/api/register", registerHandler).Methods("POST")
	r.HandleFunc("/api/login", loginHandler).Methods("POST")

	protected := r.PathPrefix("/api").Subrouter()
	protected.Use(authMiddleware)

	protected.HandleFunc("/files", listFilesHandler).Methods("GET")
	protected.HandleFunc("/upload", uploadHandler).Methods("POST")
	protected.HandleFunc("/download/{path:.*}", downloadHandler).Methods("GET")
	protected.HandleFunc("/delete/{path:.*}", deleteHandler).Methods("DELETE")
	protected.HandleFunc("/mkdir", mkdirHandler).Methods("POST")
	protected.HandleFunc("/space", spaceHandler).Methods("GET")

	// Статические файлы (frontend) — fallback на index.html для всех не-API путей
	r.PathPrefix("/").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Пропускаем API-запросы (хотя они уже обработаны выше)
		if strings.HasPrefix(r.URL.Path, "/api") {
			http.NotFound(w, r)
			return
		}

		// Для SPA или многостраничного приложения отдаём index.html
		// Если у тебя отдельные страницы — замени на конкретные пути
		http.ServeFile(w, r, "static/index.html")
		// Если нужны конкретные страницы, раскомментируй и адаптируй:
		switch r.URL.Path {
			case "/", "/index.html":
		 		http.ServeFile(w, r, "static/index.html")
			case "/login":
				http.ServeFile(w, r, "static/login.html")
			default:
		    	http.NotFound(w, r)
		}
	})

	log.Printf("Server starting on http://localhost%s", Port)
	log.Fatal(http.ListenAndServe(Port, c.Handler(r)))
}

