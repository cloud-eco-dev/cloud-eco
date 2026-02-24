// main.js — профессиональная версия CloudNET (2026)

const API_BASE = '/api';
let currentPath = '/';
let currentUser = null;
let currentShareToken = null;
let isSharedMode = false;

// ========================================
// Утилиты
// ========================================

function formatSize(bytes) {
    if (bytes === 0) return '0 Б';
    const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(file) {
    if (file.isDir) return 'folder';
    const ext = file.name.split('.').pop().toLowerCase();
    const icons = {
        'pdf': 'file-pdf', 'doc': 'file-word', 'docx': 'file-word',
        'xls': 'file-excel', 'xlsx': 'file-excel', 'ppt': 'file-powerpoint', 'pptx': 'file-powerpoint',
        'jpg': 'file-image', 'jpeg': 'file-image', 'png': 'file-image', 'gif': 'file-image',
        'mp4': 'file-video', 'mov': 'file-video', 'avi': 'file-video',
        'mp3': 'file-audio', 'zip': 'file-archive', 'rar': 'file-archive',
        'js': 'file-code', 'ts': 'file-code', 'html': 'file-code', 'css': 'file-code',
        'go': 'file-code'
    };
    return icons[ext] || 'file';
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function showLoading() {
    document.getElementById('fileList').innerHTML = `
        <tr><td colspan="5" class="loading">
            <div class="spinner"></div>
            <span>Загрузка...</span>
        </td></tr>`;
}

function showError(message) {
    document.getElementById('fileList').innerHTML = `
        <tr><td colspan="5" class="error-message">
            <i class="fas fa-exclamation-triangle"></i> ${message}
        </td></tr>`;
}

// ========================================
// Аутентификация и инициализация
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    currentShareToken = urlParams.get('token');

    if (currentShareToken) {
        isSharedMode = true;
        document.getElementById('authCheck').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        await loadSharedFiles('/');
        setupEventListeners(true);
    } else {
        const token = localStorage.getItem('token');
        if (!token) {
            window.location.href = '/login';
            return;
        }

        auth.onAuthStateChanged(async (user) => {
            if (user) {
                currentUser = user;
                document.getElementById('authCheck').style.display = 'none';
                document.getElementById('app').style.display = 'flex';
                document.getElementById('userName').textContent = user.displayName || user.email.split('@')[0];
                document.getElementById('userEmail').textContent = user.email;
                await loadFiles('/');
                await loadStorageInfo();
                setupEventListeners(false);
            } else {
                window.location.href = '/login';
            }
        });
    }

    // Темная/светлая тема
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('light');
            localStorage.setItem('theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
        });

        // Восстановить тему
        if (localStorage.getItem('theme') === 'light') {
            document.documentElement.classList.add('light');
        }
    }
});

// ========================================
// Загрузка файлов (обычный режим)
// ========================================

window.loadFiles = async function(path = '/') {
    if (!currentUser) return;

    currentPath = path.startsWith('/') ? path : '/' + path;
    currentPath = currentPath.replace(/\/+/g, '/');

    showLoading();

    try {
        const response = await fetch(`${API_BASE}/files?path=${encodeURIComponent(currentPath)}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });

        if (!response.ok) throw new Error(await response.text());

        const result = await response.json();

        if (result.success) {
            updateBreadcrumb(currentPath);
            renderFiles(result.data);
        } else {
            showError(result.error || 'Ошибка загрузки');
        }
    } catch (err) {
        console.error(err);
        showError('Ошибка соединения');
    }
};

// ========================================
// Загрузка по shared-ссылке
// ========================================

window.loadSharedFiles = async function(path = '/') {
    if (!currentShareToken) return;

    currentPath = path.startsWith('/') ? path : '/' + path;
    currentPath = currentPath.replace(/\/+/g, '/');

    showLoading();

    try {
        const response = await fetch(`${API_BASE}/files?path=${encodeURIComponent(currentPath)}&token=${currentShareToken}`);
        const result = await response.json();

        if (result.success) {
            updateBreadcrumb(currentPath, true);
            renderFiles(result.data, true);
        } else {
            showError(result.error || 'Доступ запрещён');
        }
    } catch (err) {
        showError('Ошибка доступа');
    }
};

// ========================================
// Навигация по папкам
// ========================================

window.navigateTo = function(path, isShared = false) {
    if (!path) return;
    if (isShared) {
        loadSharedFiles(path);
    } else {
        loadFiles(path);
    }
};

// ========================================
// Хлебные крошки
// ========================================

function updateBreadcrumb(path, isShared = false) {
    const breadcrumb = document.getElementById('breadcrumb');
    if (!breadcrumb) return;

    let parts = path.split('/').filter(p => p);
    let html = isShared ? '<span class="shared-icon">🔗 Общая папка</span>' : '<a href="#" onclick="navigateTo(\'/')">Мой диск</a>';

    let current = '';
    parts.forEach((part, i) => {
        current += '/' + part;
        if (i === parts.length - 1) {
            html += ` <span class="current">${part}</span>`;
        } else {
            html += ` <a href="#" onclick="navigateTo('${current}')">${part}</a> <span class="separator">/</span>`;
        }
    });

    breadcrumb.innerHTML = html;
}

// ========================================
// Отрисовка файлов (карточки + таблица)
// ========================================

function renderFiles(files, isShared = false) {
    const container = document.getElementById('fileList');
    if (!files || files.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-folder-open fa-3x"></i>
                <p>Папка пуста</p>
            </div>`;
        return;
    }

    let html = '';
    files.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    files.forEach(file => {
        const icon = getFileIcon(file);
        const size = file.isDir ? '—' : formatSize(file.size);
        const date = new Date(file.modified).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

        html += `
            <div class="file-card ${file.isDir ? 'folder' : 'file'}" onclick="navigateTo('${file.path}', ${isShared})" data-path="${file.path}">
                <div class="file-icon">
                    <i class="fas fa-${icon}"></i>
                </div>
                <div class="file-name">${file.name}</div>
                <div class="file-size">${size}</div>
                <div class="file-date">${date}</div>
                <div class="file-actions">
                    ${!file.isDir ? `<button class="action-btn download" onclick="event.stopPropagation(); downloadFile('${file.path}', ${isShared})"><i class="fas fa-download"></i></button>` : ''}
                    ${!isShared ? `<button class="action-btn delete" onclick="event.stopPropagation(); deleteFile('${file.path}')"><i class="fas fa-trash-alt"></i></button>` : ''}
                </div>
            </div>`;
    });

    container.innerHTML = html;
}

// ========================================
// Загрузка файлов
// ========================================

window.triggerFileUpload = function() {
    document.getElementById('fileInput').click();
};

async function uploadFiles(files) {
    if (!files?.length) return;

    showUploadProgress(0, files.length);

    let success = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append('file', file);

        try {
            let url = `${API_BASE}/upload?path=${encodeURIComponent(currentPath)}`;
            let headers = {};

            if (currentShareToken) {
                url += `&token=${currentShareToken}`;
            } else if (currentUser) {
                headers['Authorization'] = `Bearer ${localStorage.getItem('token')}`;
            }

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                success++;
            } else {
                failed++;
                showToast(`Ошибка загрузки ${file.name}: ${result.error}`, 'error');
            }

            showUploadProgress(i + 1, files.length);
        } catch (err) {
            failed++;
            showToast(`Ошибка сети при загрузке ${file.name}`, 'error');
        }
    }

    hideUploadProgress();

    if (success > 0) {
        showToast(`Загружено ${success} из ${files.length} файлов`, 'success');
        if (isSharedMode) {
            loadSharedFiles(currentPath);
        } else {
            loadFiles(currentPath);
            loadStorageInfo();
        }
    }
}

// ========================================
// Создание папки
// ========================================

window.createFolder = function() {
    document.getElementById('folderModal').classList.add('show');
    document.getElementById('folderName').focus();
};

window.closeFolderModal = function() {
    document.getElementById('folderModal').classList.remove('show');
};

window.createFolderConfirm = async function() {
    const name = document.getElementById('folderName').value.trim();
    if (!name) {
        showToast('Введите имя папки', 'warning');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/mkdir`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ path: currentPath, name })
        });

        const result = await response.json();

        if (result.success) {
            closeFolderModal();
            loadFiles(currentPath);
            showToast('Папка создана', 'success');
        } else {
            showToast(result.error || 'Ошибка создания', 'error');
        }
    } catch (err) {
        showToast('Ошибка сети', 'error');
    }
};

// ========================================
// Удаление
// ========================================

window.deleteFile = async function(path) {
    if (!confirm('Удалить этот элемент навсегда?')) return;

    try {
        const response = await fetch(`${API_BASE}/delete/${encodeURIComponent(path)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });

        const result = await response.json();

        if (result.success) {
            loadFiles(currentPath);
            showToast('Удалено успешно', 'success');
        } else {
            showToast(result.error || 'Ошибка удаления', 'error');
        }
    } catch (err) {
        showToast('Ошибка сети', 'error');
    }
};

// ========================================
// Скачивание
// ========================================

window.downloadFile = function(path) {
    const url = `${API_BASE}/download/${encodeURIComponent(path)}`;
    const token = localStorage.getItem('token');
    window.location.href = token ? `${url}?token=${token}` : url;
};

// ========================================
// Хранилище
// ========================================

async function loadStorageInfo() {
    try {
        const response = await fetch(`${API_BASE}/space`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const result = await response.json();

        if (result.success) {
            const data = result.data;
            document.getElementById('storageUsedBar').style.width = `${data.percent}%`;
            document.getElementById('storageText').textContent = 
                `Использовано ${formatSize(data.used)} из ${formatSize(data.max)} (${data.percent.toFixed(1)}%)`;
        }
    } catch (err) {
        console.error('Ошибка загрузки места:', err);
    }
}

// ========================================
// Прогресс загрузки
// ========================================

function showUploadProgress(current, total) {
    let bar = document.getElementById('uploadProgress');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'uploadProgress';
        bar.innerHTML = `
            <div class="progress-container">
                <div class="progress-bar" id="uploadBar"></div>
                <span id="uploadText">0%</span>
            </div>`;
        document.body.appendChild(bar);
    }
    const percent = Math.round((current / total) * 100);
    document.getElementById('uploadBar').style.width = `${percent}%`;
    document.getElementById('uploadText').textContent = `${percent}%`;
}

function hideUploadProgress() {
    const bar = document.getElementById('uploadProgress');
    if (bar) bar.remove();
}

// ========================================
// Drag & Drop + события
// ========================================

function setupEventListeners(isShared) {
    const dropZone = document.getElementById('dropZone');

    dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        uploadFiles(e.dataTransfer.files);
    });

    dropZone.addEventListener('click', () => document.getElementById('fileInput').click());

    document.getElementById('fileInput').addEventListener('change', e => {
        uploadFiles(e.target.files);
        e.target.value = '';
    });
}

// ========================================
// Выход
// ========================================

window.logout = async function() {
    try {
        await auth.signOut();
        localStorage.clear();
        window.location.href = '/login';
    } catch (err) {
        showToast('Ошибка выхода', 'error');
    }
};
