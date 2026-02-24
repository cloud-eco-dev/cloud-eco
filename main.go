package main

import (
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

	"github.com/dgrijalva/jwt-go"
	"github.com/gorilla/mux"
	"github.com/rs/cors"
	"golang.org/x/net/context"
)

const (
	Port           = ":8080"
	UploadsDir     = "uploads"
	MaxFileSize    = 100 << 20 // 100 MB
	JWTSecret      = "super-secret-key-2026-change-me" // В продакшене — из .env или Vault
	TokenDuration  = 24 * time.Hour
	DefaultMaxSize = 5 * 1024 * 1024 * 1024 // 5 GB на пользователя
)

type User struct {
	UID      string `json:"uid"`
	Email    string `json:"email"`
	Password string `json:"-"` // хешированный пароль в реальном проекте
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
	users      = map[string]User{} // email -> user
	shareLinks = map[string]ShareLink{}
	mu         = &sync.RWMutex{}
)

func generateToken(length int) string {
	b := make([]byte, length)
	_, err := rand.Read(b)
	if err != nil {
		log.Fatal(err)
	}
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
	cleanPath := filepath.Clean("/" + strings.TrimPrefix(requestedPath, "/"))
	if strings.HasPrefix(cleanPath, "..") || strings.Contains(cleanPath, "../") {
		return "", fmt.Errorf("invalid path")
	}
	return filepath.Join(UploadsDir, uid, cleanPath[1:]), nil
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
	err := json.NewEncoder(w).Encode(resp)
	if err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenStr := r.Header.Get("Authorization")
		if tokenStr == "" || !strings.HasPrefix(tokenStr, "Bearer ") {
			jsonResponse(w, Response{Success: false, Error: "Unauthorized"}, http.StatusUnauthorized)
			return
		}
		tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")

		token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(JWTSecret), nil
		})
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

		ctx := r.Context()
		ctx = context.WithValue(ctx, "uid", uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

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
	if _, exists := users[req.Email]; exists {
		mu.Unlock()
		jsonResponse(w, Response{Success: false, Error: "User already exists"}, http.StatusConflict)
		return
	}
	uid := generateToken(16)
	users[req.Email] = User{
		UID:      uid,
		Email:    req.Email,
		Password: req.Password, // TODO: hash with bcrypt
	}
	mu.Unlock()

	token, err := generateJWT(uid)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Failed to generate token"}, http.StatusInternalServerError)
		return
	}
	jsonResponse(w, Response{
		Success: true,
		Data: map[string]string{"token": token, "uid": uid},
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
		Data: map[string]string{"token": token, "uid": user.UID},
	}, http.StatusOK)
}

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
		err := os.MkdirAll(fullPath, 0755)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Failed to create directory"}, http.StatusInternalServerError)
			return
		}
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
		info, err := entry.Info()
		if err != nil {
			continue
		}
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
		jsonResponse(w, Response{Success: false, Error: "File too large"}, http.StatusBadRequest)
		return
	}

	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		jsonResponse(w, Response{Success: false, Error: "No files uploaded"}, http.StatusBadRequest)
		return
	}

	os.MkdirAll(fullPath, 0755)

	var uploaded []string
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			log.Printf("Failed to open file: %v", err)
			continue
		}
		defer f.Close()

		destFile := filepath.Join(fullPath, fh.Filename)
		// Handle existing file (add counter)
		if _, err := os.Stat(destFile); err == nil {
			ext := filepath.Ext(fh.Filename)
			base := strings.TrimSuffix(fh.Filename, ext)
			counter := 1
			for {
				newName := fmt.Sprintf("%s (%d)%s", base, counter, ext)
				newPath := filepath.Join(fullPath, newName)
				if _, err := os.Stat(newPath); os.IsNotExist(err) {
					destFile = newPath
					break
				}
				counter++
			}
		}

		dst, err := os.Create(destFile)
		if err != nil {
			log.Printf("Failed to create file: %v", err)
			continue
		}
		defer dst.Close()

		_, err = io.Copy(dst, f)
		if err != nil {
			log.Printf("Failed to copy file: %v", err)
			continue
		}

		uploaded = append(uploaded, fh.Filename)
	}

	jsonResponse(w, Response{Success: true, Message: fmt.Sprintf("Uploaded %d files", len(uploaded)), Data: uploaded}, http.StatusOK)
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	vars := mux.Vars(r)
	path := vars["path"]
	if path == "" {
		jsonResponse(w, Response{Success: false, Error: "Path required"}, http.StatusBadRequest)
		return
	}

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
	if path == "" {
		jsonResponse(w, Response{Success: false, Error: "Path required"}, http.StatusBadRequest)
		return
	}

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

	jsonResponse(w, Response{Success: true, Message: "Deleted"}, http.StatusOK)
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

	basePath, err := getSafePath(uid, req.Path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid base path"}, http.StatusBadRequest)
		return
	}

	fullPath := filepath.Join(basePath, req.Name)
	if _, err := os.Stat(fullPath); err == nil {
		jsonResponse(w, Response{Success: false, Error: "Directory already exists"}, http.StatusConflict)
		return
	}

	err = os.MkdirAll(fullPath, 0755)
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
			MaxGB:   float64(DefaultMaxSize) / (1024 * 1024 * 1024),
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
		UsedGB:  float64(used) / (1024 * 1024 * 1024),
		MaxGB:   float64(DefaultMaxSize) / (1024 * 1024 * 1024),
		Percent: percent,
	}}, http.StatusOK)
}

func createShareLinkHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	var req struct {
		Path       string `json:"path"`
		Permission string `json:"permission"`
		ExpiresIn  int    `json:"expiresIn"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid request"}, http.StatusBadRequest)
		return
	}

	fullPath, err := getSafePath(uid, req.Path)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid path"}, http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonResponse(w, Response{Success: false, Error: "Path not found"}, http.StatusNotFound)
		return
	}

	expiresIn := time.Duration(req.ExpiresIn) * time.Hour
	if expiresIn <= 0 {
		expiresIn = 24 * time.Hour
	}

	token := generateToken(32)
	linkID := generateToken(8)

	mu.Lock()
	shareLinks[token] = ShareLink{
		ID:         linkID,
		Path:       req.Path,
		OwnerUID:   uid,
		CreatedAt:  time.Now(),
		ExpiresAt:  time.Now().Add(expiresIn),
		Permission: req.Permission,
		Token:      token,
	}
	mu.Unlock()

	shareURL := fmt.Sprintf("http://%s/shared?token=%s", r.Host, token)
	jsonResponse(w, Response{
		Success: true,
		Data: map[string]interface{}{
			"id":         linkID,
			"url":        shareURL,
			"token":      token,
			"path":       req.Path,
			"permission": req.Permission,
			"expiresAt":  shareLinks[token].ExpiresAt,
		},
	}, http.StatusCreated)
}

func listShareLinksHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	mu.RLock()
	defer mu.RUnlock()

	var links []ShareLink
	now := time.Now()
	for _, link := range shareLinks {
		if link.OwnerUID == uid && now.Before(link.ExpiresAt) {
			links = append(links, link)
		}
	}

	jsonResponse(w, Response{Success: true, Data: links}, http.StatusOK)
}

func deleteShareLinkHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Context().Value("uid").(string)
	vars := mux.Vars(r)
	linkID := vars["id"]

	mu.Lock()
	defer mu.Unlock()

	for token, link := range shareLinks {
		if link.ID == linkID && link.OwnerUID == uid {
			delete(shareLinks, token)
			jsonResponse(w, Response{Success: true, Message: "Share link deleted"}, http.StatusOK)
			return
		}
	}

	jsonResponse(w, Response{Success: false, Error: "Share link not found"}, http.StatusNotFound)
}

func serveStatic(w http.ResponseWriter, r *http.Request) {
	http.FileServer(http.Dir("static")).ServeHTTP(w, r)
}

func main() {
	os.MkdirAll(UploadsDir, 0755)

	r := mux.NewRouter()

	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "DELETE", "PUT", "OPTIONS"},
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
	protected.HandleFunc("/share/create", createShareLinkHandler).Methods("POST")
	protected.HandleFunc("/share/list", listShareLinksHandler).Methods("GET")
	protected.HandleFunc("/share/delete/{id}", deleteShareLinkHandler).Methods("DELETE")

	r.PathPrefix("/").HandlerFunc(serveStatic)

	log.Printf("Server starting on %s", Port)
	log.Fatal(http.ListenAndServe(Port, c.Handler(r)))
}
