package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

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
	Used    int64   `json:"used"`
	Max     int64   `json:"max"`
	UsedGB  float64 `json:"usedGB"`
	MaxGB   float64 `json:"maxGB"`
	Percent float64 `json:"percent"`
}

// Структура для шаринга
type ShareLink struct {
	ID         string    `json:"id"`
	Path       string    `json:"path"`
	OwnerUID   string    `json:"ownerUid"`
	CreatedAt  time.Time `json:"createdAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Permission string    `json:"permission"` // "read" или "write"
	Token      string    `json:"token"`
}

// Хранилище ссылок для доступа (в памяти)
var (
	shareLinks = make(map[string]ShareLink)
	linksMutex = &sync.RWMutex{}
)

func main() {
	// Создаем папку для загрузок
	os.MkdirAll("uploads", os.ModePerm)

	r := mux.NewRouter()

	// Раздача статических файлов
	r.PathPrefix("/static/").Handler(http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	r.PathPrefix("/css/").Handler(http.StripPrefix("/css/", http.FileServer(http.Dir("static/css"))))
	r.PathPrefix("/js/").Handler(http.StripPrefix("/js/", http.FileServer(http.Dir("static/js"))))

	// Страницы
	r.HandleFunc("/", serveIndex)
	r.HandleFunc("/login", serveLogin)
	r.HandleFunc("/shared", serveShared)

	// API для файлов
	r.HandleFunc("/api/files", listFilesHandler).Methods("GET")
	r.HandleFunc("/api/upload", uploadHandler).Methods("POST")
	r.HandleFunc("/api/download/", downloadHandler).Methods("GET")
	r.HandleFunc("/api/delete/", deleteHandler).Methods("DELETE")
	r.HandleFunc("/api/mkdir", mkdirHandler).Methods("POST")
	r.HandleFunc("/api/space", spaceHandler).Methods("GET")
	
	// API для шаринга
	r.HandleFunc("/api/share/create", createShareLinkHandler).Methods("POST")
	r.HandleFunc("/api/share/list", listShareLinksHandler).Methods("GET")
	r.HandleFunc("/api/share/delete/{id}", deleteShareLinkHandler).Methods("DELETE")

	fmt.Println("🚀 Сервер запущен на http://localhost:8080")
	fmt.Println("📁 Страница входа: http://localhost:8080/login")
	http.ListenAndServe(":8080", r)
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, "static/index.html")
}

func serveLogin(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "static/login.html")
}

func serveShared(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "static/index.html")
}

// Генерация случайного токена
func generateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Создание ссылки для доступа
func createShareLinkHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Path       string `json:"path"`
		Permission string `json:"permission"`
		ExpiresIn  int    `json:"expiresIn"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Неверный запрос"})
		return
	}

	// Проверяем существование папки/файла
	var fullPath string
	if req.Path == "/" || req.Path == "" {
		fullPath = filepath.Join("uploads", uid)
	} else {
		// Убираем ведущий слеш и создаем полный путь
		cleanPath := strings.TrimPrefix(req.Path, "/")
		fullPath = filepath.Join("uploads", uid, cleanPath)
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Путь не найден"})
		return
	}

	// Устанавливаем время жизни (по умолчанию 24 часа)
	expiresIn := req.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 24
	}

	// Генерируем токен
	token := generateToken()
	
	shareLink := ShareLink{
		ID:         generateToken()[:8],
		Path:       req.Path,
		OwnerUID:   uid,
		CreatedAt:  time.Now(),
		ExpiresAt:  time.Now().Add(time.Duration(expiresIn) * time.Hour),
		Permission: req.Permission,
		Token:      token,
	}

	linksMutex.Lock()
	shareLinks[token] = shareLink
	linksMutex.Unlock()

	// Формируем ссылку
	shareURL := fmt.Sprintf("http://%s/shared?token=%s", r.Host, token)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		Success: true,
		Data: map[string]interface{}{
			"id":         shareLink.ID,
			"url":        shareURL,
			"token":      token,
			"path":       req.Path,
			"permission": req.Permission,
			"expiresAt":  shareLink.ExpiresAt,
		},
	})
}

// Получение списка активных ссылок
func listShareLinksHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	linksMutex.RLock()
	defer linksMutex.RUnlock()

	var userLinks []map[string]interface{}
	now := time.Now()

	for _, link := range shareLinks {
		if link.OwnerUID == uid && now.Before(link.ExpiresAt) {
			userLinks = append(userLinks, map[string]interface{}{
				"id":         link.ID,
				"path":       link.Path,
				"permission": link.Permission,
				"expiresAt":  link.ExpiresAt,
				"token":      link.Token,
				"url":        fmt.Sprintf("http://%s/shared?token=%s", r.Host, link.Token),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		Success: true,
		Data:    userLinks,
	})
}

// Удаление ссылки
func deleteShareLinkHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vars := mux.Vars(r)
	linkID := vars["id"]

	linksMutex.Lock()
	defer linksMutex.Unlock()

	for token, link := range shareLinks {
		if link.ID == linkID && link.OwnerUID == uid {
			delete(shareLinks, token)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: true, Message: "Ссылка удалена"})
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: false, Error: "Ссылка не найдена"})
}

// Получение списка файлов и папок
func listFilesHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	// Проверяем токен доступа
	shareToken := r.URL.Query().Get("token")
	var ownerUID string
	var basePath string

	if shareToken != "" {
		linksMutex.RLock()
		link, exists := shareLinks[shareToken]
		linksMutex.RUnlock()

		if !exists || time.Now().After(link.ExpiresAt) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Ссылка недействительна"})
			return
		}

		ownerUID = link.OwnerUID
		basePath = link.Path
	} else {
		ownerUID = uid
		basePath = path
	}

	// Формируем полный путь к папке
	var fullPath string
	if basePath == "/" || basePath == "" {
		fullPath = filepath.Join("uploads", ownerUID)
	} else {
		// Убираем ведущий слеш и создаем путь
		cleanPath := strings.TrimPrefix(basePath, "/")
		fullPath = filepath.Join("uploads", ownerUID, cleanPath)
	}
	
	// Проверяем существование папки
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		// Если папки нет, создаем её (только для владельца)
		if shareToken == "" {
			os.MkdirAll(fullPath, os.ModePerm)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: true, Data: []FileInfo{}})
		return
	}

	files, err := os.ReadDir(fullPath)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Ошибка чтения папки"})
		return
	}

	var fileList []FileInfo
	for _, f := range files {
		info, _ := f.Info()
		
		// Формируем путь для клиента
		var clientPath string
		if basePath == "/" {
			clientPath = "/" + f.Name()
		} else {
			clientPath = basePath + "/" + f.Name()
		}
		
		fileList = append(fileList, FileInfo{
			Name:     f.Name(),
			Path:     clientPath,
			Size:     info.Size(),
			IsDir:    f.IsDir(),
			Modified: info.ModTime(),
		})
	}

	// Добавляем информацию о режиме доступа
	if shareToken != "" {
		linksMutex.RLock()
		link, _ := shareLinks[shareToken]
		linksMutex.RUnlock()
		w.Header().Set("X-Access-Permission", link.Permission)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true, Data: fileList})
}

// Загрузка файла
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	// Проверяем токен доступа
	shareToken := r.URL.Query().Get("token")
	var ownerUID string
	var basePath string

	if shareToken != "" {
		linksMutex.RLock()
		link, exists := shareLinks[shareToken]
		linksMutex.RUnlock()

		if !exists || time.Now().After(link.ExpiresAt) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Ссылка недействительна"})
			return
		}

		if link.Permission != "write" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Нет прав на запись"})
			return
		}

		ownerUID = link.OwnerUID
		basePath = link.Path
	} else {
		ownerUID = uid
		basePath = path
	}

	// Максимальный размер 100 MB
	err := r.ParseMultipartForm(100 << 20)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Файл слишком большой"})
		return
	}

	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Нет файлов для загрузки"})
		return
	}

	// Формируем путь назначения
	var destDir string
	if basePath == "/" || basePath == "" {
		destDir = filepath.Join("uploads", ownerUID)
	} else {
		cleanPath := strings.TrimPrefix(basePath, "/")
		destDir = filepath.Join("uploads", ownerUID, cleanPath)
	}

	// Создаем папку назначения
	os.MkdirAll(destDir, os.ModePerm)

	var uploadedFiles []map[string]string

	for _, fileHeader := range files {
		file, err := fileHeader.Open()
		if err != nil {
			continue
		}
		defer file.Close()

		// Сохраняем файл с оригинальным именем
		fileName := fileHeader.Filename
		filePath := filepath.Join(destDir, fileName)
		
		// Если файл уже существует, добавляем число к имени
		if _, err := os.Stat(filePath); err == nil {
			ext := filepath.Ext(fileName)
			nameWithoutExt := strings.TrimSuffix(fileName, ext)
			counter := 1
			for {
				newName := fmt.Sprintf("%s (%d)%s", nameWithoutExt, counter, ext)
				filePath = filepath.Join(destDir, newName)
				if _, err := os.Stat(filePath); os.IsNotExist(err) {
					fileName = newName
					break
				}
				counter++
			}
		}
		
		dst, err := os.Create(filePath)
		if err != nil {
			continue
		}
		
		_, err = io.Copy(dst, file)
		dst.Close()
		
		if err != nil {
			continue
		}

		// Формируем путь для ответа
		var responsePath string
		if basePath == "/" {
			responsePath = "/" + fileName
		} else {
			responsePath = basePath + "/" + fileName
		}

		uploadedFiles = append(uploadedFiles, map[string]string{
			"name": fileName,
			"path": responsePath,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		Success: true,
		Message: fmt.Sprintf("Загружено файлов: %d", len(uploadedFiles)),
		Data:    uploadedFiles,
	})
}

// Создание папки
func mkdirHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	var req struct {
		Path  string `json:"path"`
		Name  string `json:"name"`
		Token string `json:"token"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Неверный запрос"})
		return
	}

	// Проверяем права доступа
	var ownerUID string
	var basePath string

	if req.Token != "" {
		linksMutex.RLock()
		link, exists := shareLinks[req.Token]
		linksMutex.RUnlock()

		if !exists || time.Now().After(link.ExpiresAt) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Ссылка недействительна"})
			return
		}

		if link.Permission != "write" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Нет прав на запись"})
			return
		}

		ownerUID = link.OwnerUID
		basePath = link.Path
	} else {
		ownerUID = uid
		basePath = req.Path
	}

	// Проверяем имя папки
	if req.Name == "" || strings.ContainsAny(req.Name, "/\\:*?\"<>|") {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Некорректное имя папки"})
		return
	}

	// Формируем путь для новой папки
	var folderPath string
	if basePath == "/" || basePath == "" {
		folderPath = filepath.Join("uploads", ownerUID, req.Name)
	} else {
		cleanPath := strings.TrimPrefix(basePath, "/")
		folderPath = filepath.Join("uploads", ownerUID, cleanPath, req.Name)
	}
	
	// Проверяем, не существует ли уже такая папка
	if _, err := os.Stat(folderPath); err == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Папка уже существует"})
		return
	}

	if err := os.MkdirAll(folderPath, os.ModePerm); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Ошибка создания папки"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true, Message: "Папка создана"})
}

// Удаление файла или папки
func deleteHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Получаем путь из URL
	fullPath := strings.TrimPrefix(r.URL.Path, "/api/delete/")
	if fullPath == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Путь не указан"})
		return
	}

	// Проверяем токен доступа
	shareToken := r.URL.Query().Get("token")
	var ownerUID string

	if shareToken != "" {
		linksMutex.RLock()
		link, exists := shareLinks[shareToken]
		linksMutex.RUnlock()

		if !exists || time.Now().After(link.ExpiresAt) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Ссылка недействительна"})
			return
		}

		if link.Permission != "write" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(Response{Success: false, Error: "Нет прав на удаление"})
			return
		}

		ownerUID = link.OwnerUID
	} else {
		ownerUID = uid
	}

	// Убираем ведущий слеш
	cleanPath := strings.TrimPrefix(fullPath, "/")
	
	// Проверяем, не пытается ли пользователь удалить корневую папку
	if cleanPath == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Нельзя удалить корневую папку"})
		return
	}
	
	deletePath := filepath.Join("uploads", ownerUID, cleanPath)
	
	// Проверяем, существует ли файл/папка
	if _, err := os.Stat(deletePath); os.IsNotExist(err) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Файл или папка не найдены"})
		return
	}
	
	// Удаляем
	if err := os.RemoveAll(deletePath); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Ошибка удаления"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Success: true, Message: "Удалено"})
}

// Скачивание файла
func downloadHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.URL.Query().Get("uid")
	if uid == "" {
		uid = r.Header.Get("X-User-UID")
	}
	
	shareToken := r.URL.Query().Get("token")
	
	var ownerUID string

	if shareToken != "" {
		linksMutex.RLock()
		link, exists := shareLinks[shareToken]
		linksMutex.RUnlock()

		if !exists || time.Now().After(link.ExpiresAt) {
			http.Error(w, "Ссылка недействительна", http.StatusForbidden)
			return
		}

		ownerUID = link.OwnerUID
	} else {
		if uid == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		ownerUID = uid
	}

	fullPath := strings.TrimPrefix(r.URL.Path, "/api/download/")
	if fullPath == "" {
		http.Error(w, "Путь не указан", http.StatusBadRequest)
		return
	}

	// Убираем ведущий слеш
	cleanPath := strings.TrimPrefix(fullPath, "/")
	
	filePath := filepath.Join("uploads", ownerUID, cleanPath)
	
	// Проверяем, что это файл, а не папка
	fileInfo, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Файл не найден", http.StatusNotFound)
		} else {
			http.Error(w, "Ошибка доступа к файлу", http.StatusInternalServerError)
		}
		return
	}
	
	if fileInfo.IsDir() {
		http.Error(w, "Нельзя скачать папку", http.StatusBadRequest)
		return
	}
	
	// Устанавливаем заголовки для скачивания
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(filePath)+"\"")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", fileInfo.Size()))
	
	http.ServeFile(w, r, filePath)
}

// Информация о месте
func spaceHandler(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-UID")
	if uid == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	userPath := filepath.Join("uploads", uid)
	
	if _, err := os.Stat(userPath); os.IsNotExist(err) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{
			Success: true,
			Data: SpaceInfo{
				Used:    0,
				Max:     500 * 1024 * 1024,
				UsedGB:  0,
				MaxGB:   0.5,
				Percent: 0,
			},
		})
		return
	}
	
	var totalSize int64
	err := filepath.Walk(userPath, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			totalSize += info.Size()
		}
		return nil
	})
	
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{Success: false, Error: "Ошибка подсчета места"})
		return
	}

	maxSize := int64(500 * 1024 * 1024)
	percent := float64(totalSize) / float64(maxSize) * 100

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		Success: true,
		Data: SpaceInfo{
			Used:    totalSize,
			Max:     maxSize,
			UsedGB:  float64(totalSize) / (1024 * 1024 * 1024),
			MaxGB:   0.5,
			Percent: percent,
		},
	})
}