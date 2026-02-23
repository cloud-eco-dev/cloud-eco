let currentPath = '/';
let currentUser = null;
let currentShareToken = null;
let isMobileMenuOpen = false;

// Переключение мобильного меню
window.toggleMobileMenu = function () {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('mobileMenuOverlay');

    isMobileMenuOpen = !isMobileMenuOpen;

    if (isMobileMenuOpen) {
        sidebar.classList.add('open');
        overlay.classList.add('show');
        document.body.style.overflow = 'hidden';
    } else {
        sidebar.classList.remove('open');
        overlay.classList.remove('show');
        document.body.style.overflow = '';
    }
};

window.closeMobileMenu = function () {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('mobileMenuOverlay');

    isMobileMenuOpen = false;
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    document.body.style.overflow = '';
};

// Закрывать меню при клике на ссылку
document.addEventListener('DOMContentLoaded', function () {
    const menuLinks = document.querySelectorAll('.nav-menu a');
    menuLinks.forEach(link => {
        link.addEventListener('click', function () {
            if (window.innerWidth <= 768) {
                closeMobileMenu();
            }
        });
    });
});

// Следим за изменением размера окна
window.addEventListener('resize', function () {
    if (window.innerWidth > 768 && isMobileMenuOpen) {
        closeMobileMenu();
    }
});

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    // Проверяем токен в URL
    const urlParams = new URLSearchParams(window.location.search);
    currentShareToken = urlParams.get('token');
    
    if (currentShareToken) {
        // Режим доступа по ссылке
        document.getElementById('authCheck').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        
        // Скрываем кнопки для режима только для чтения
        await checkSharedAccess();
        
        // Загружаем файлы из расшаренной папки
        await loadSharedFiles('/');
        setupEventListeners(true);
    } else {
        // Обычный режим
        const userUID = localStorage.getItem('userUID');

        if (!userUID) {
            window.location.href = '/login';
            return;
        }

        auth.onAuthStateChanged(async (user) => {
            if (user && user.emailVerified) {
                currentUser = user;
                document.getElementById('authCheck').style.display = 'none';
                document.getElementById('app').style.display = 'flex';

                document.getElementById('userName').textContent = user.displayName || 'Пользователь';
                document.getElementById('userEmail').textContent = user.email;

                // Загружаем файлы
                await loadFiles('/');
                loadStorageInfo();
                setupEventListeners(false);
            } else {
                window.location.href = '/login';
            }
        });
    }
});

// Проверка прав доступа при шаринге
async function checkSharedAccess() {
    try {
        const response = await fetch(`/api/share/access/${currentShareToken}`);
        const result = await response.json();
        
        if (result.success) {
            const accessInfo = result.data;
            
            document.getElementById('userName').textContent = 'Гостевой доступ';
            document.getElementById('userEmail').textContent = `Папка: ${accessInfo.path}`;
            
            // Если только чтение - скрываем кнопки создания
            if (accessInfo.permission !== 'write') {
                document.getElementById('newBtn').style.display = 'none';
                document.querySelector('.logout-btn').style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Ошибка проверки доступа:', error);
    }
}

// Настройка обработчиков
function setupEventListeners(isShared = false) {
    const dropZone = document.getElementById('dropZone');
    const newBtn = document.getElementById('newBtn');
    const newMenu = document.getElementById('newMenu');
    const fileInput = document.getElementById('fileInput');

    // Drag & Drop
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (currentUser || isShared) dropZone.classList.add('show');
    });

    document.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !e.relatedTarget.closest) {
            dropZone.classList.remove('show');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('show');

        if (!currentUser && !isShared) return;

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            uploadFiles(files);
        }
    });

    // Кнопка создания
    if (newBtn) {
        newBtn.addEventListener('click', () => {
            newMenu.classList.toggle('show');
        });
    }

    // Закрытие меню при клике вне
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#newBtn') && !e.target.closest('#newMenu')) {
            if (newMenu) newMenu.classList.remove('show');
        }
    });

    // Выбор файлов
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                uploadFiles(e.target.files);
            }
            e.target.value = '';
        });
    }
}

// Загрузка файлов (обычный режим)
window.loadFiles = async function (path) {
    if (!currentUser) return;
    
    if (path === undefined || path === null) {
        path = currentPath;
    }
    
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    
    path = path.replace(/\/+/g, '/');
    currentPath = path;

    try {
        showLoading();
        
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
            headers: { 'X-User-UID': currentUser.uid }
        });
        
        const result = await response.json();

        if (result.success) {
            updateBreadcrumb(path, false);
            renderFiles(result.data, false);
        } else {
            showError(result.error || 'Ошибка загрузки файлов');
        }
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        showError('Ошибка соединения с сервером');
    }
};

// Загрузка расшаренных файлов
window.loadSharedFiles = async function (path) {
    if (!currentShareToken) return;
    
    if (path === undefined || path === null) {
        path = currentPath;
    }
    
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    
    path = path.replace(/\/+/g, '/');
    currentPath = path;

    try {
        showLoading();
        
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}&token=${currentShareToken}`);
        const result = await response.json();
        
        if (result.success) {
            updateBreadcrumb(path, true);
            renderFiles(result.data, true);
        } else {
            showError(result.error || 'Ошибка загрузки файлов');
        }
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        showError('Ошибка соединения с сервером');
    }
};

// Навигация по папкам - ИСПРАВЛЕНО
window.navigateTo = function (path, isShared = false, event) {
    // Если событие есть и оно всплыло от кнопки - не навигируем
    if (event && (event.target.tagName === 'BUTTON' || event.target.closest('button'))) {
        return;
    }
    
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    
    path = path.replace(/\/+/g, '/');
    
    const fileName = path.split('/').pop();
    if (fileName && fileName.includes('.')) {
        return;
    }
    
    console.log('Навигация в папку:', path); // Для отладки
    
    if (isShared) {
        loadSharedFiles(path);
    } else {
        loadFiles(path);
    }
};

// Обновление хлебных крошек
function updateBreadcrumb(path, isShared = false) {
    const breadcrumb = document.getElementById('breadcrumb');
    
    let parts = path.split('/').filter(p => p && p !== '');
    
    let html = '';
    
    if (isShared) {
        html = '<a href="#" onclick="loadSharedFiles(\'/\', false, event); return false;">Общая папка</a>';
    } else {
        html = '<a href="#" onclick="loadFiles(\'/\', false, event); return false;">Мой диск</a>';
    }
    
    let currentPath = '';
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath += '/' + part;
        
        if (i === parts.length - 1) {
            html += ` <span>/</span> <span>${part}</span>`;
        } else {
            html += ` <span>/</span> <a href="#" onclick="${isShared ? 'loadSharedFiles' : 'loadFiles'}('${currentPath}', false, event); return false;">${part}</a>`;
        }
    }
    
    breadcrumb.innerHTML = html;
}

// Отрисовка файлов - ИСПРАВЛЕНО
function renderFiles(files, isShared = false) {
    const tbody = document.getElementById('fileList');

    if (!files || files.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="loading">
                    <i class="fas fa-folder-open"></i> Папка пуста
                </td>
            </tr>
        `;
        return;
    }

    files.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    let html = '';
    files.forEach(file => {
        const icon = getFileIcon(file);
        const size = file.isDir ? '—' : formatSize(file.size);
        const date = new Date(file.modified).toLocaleString();

        html += `
            <tr ondblclick="navigateTo('${file.path}', ${isShared}, event)">
                <td>
                    <i class="fas ${icon} file-icon" style="color: ${getIconColor(file)}"></i>
                </td>
                <td>${file.name}</td>
                <td>${size}</td>
                <td>${date}</td>
                <td class="file-actions">
                    ${!file.isDir ? `<button onclick="downloadFile('${file.path}', ${isShared}, event)" title="Скачать"><i class="fas fa-download"></i></button>` : ''}
                    ${!isShared ? `<button onclick="deleteFile('${file.path}', event)" title="Удалить"><i class="fas fa-trash"></i></button>` : ''}
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

// Загрузка файлов
window.triggerFileUpload = function () {
    document.getElementById('fileInput').click();
};

async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    
    showUploadProgress(0, files.length);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append('file', file);

        try {
            let url = `/api/upload?path=${encodeURIComponent(currentPath)}`;
            let headers = {};
            
            if (currentShareToken) {
                url += `&token=${currentShareToken}`;
            } else if (currentUser) {
                headers['X-User-UID'] = currentUser.uid;
            } else {
                errorCount++;
                continue;
            }
            
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: formData
            });
            
            const result = await response.json();
            
            if (result.success) {
                successCount++;
            } else {
                errorCount++;
                alert(`Ошибка при загрузке ${file.name}: ${result.error || 'Неизвестная ошибка'}`);
            }
            
            showUploadProgress(i + 1, files.length);
            
        } catch (error) {
            errorCount++;
            console.error('Ошибка загрузки:', error);
            alert(`Ошибка при загрузке ${file.name}: ${error.message}`);
        }
    }

    hideUploadProgress();
    
    if (successCount > 0) {
        if (currentShareToken) {
            await loadSharedFiles(currentPath);
        } else {
            await loadFiles(currentPath);
            loadStorageInfo();
        }
    }
}

// Создание папки
window.createFolder = function () {
    document.getElementById('newMenu').classList.remove('show');
    document.getElementById('folderModal').classList.add('show');
    document.getElementById('folderName').value = '';
    document.getElementById('folderName').focus();
};

window.closeFolderModal = function () {
    document.getElementById('folderModal').classList.remove('show');
};

window.createFolderConfirm = async function () {
    const name = document.getElementById('folderName').value.trim();
    if (!name) return;

    try {
        let url = '/api/mkdir';
        let headers = { 'Content-Type': 'application/json' };
        let body = {};
        
        if (currentShareToken) {
            body = { path: currentPath, name, token: currentShareToken };
        } else if (currentUser) {
            headers['X-User-UID'] = currentUser.uid;
            body = { path: currentPath, name };
        } else {
            return;
        }
        
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });
        
        const result = await response.json();

        if (result.success) {
            closeFolderModal();
            if (currentShareToken) {
                await loadSharedFiles(currentPath);
            } else {
                await loadFiles(currentPath);
            }
        } else {
            alert(result.error || 'Ошибка создания папки');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка при создании папки');
    }
};

// Удаление - ИСПРАВЛЕНО
window.deleteFile = async function (path, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    if (!confirm('Удалить этот элемент?')) return;

    try {
        let url = `/api/delete/${encodeURIComponent(path)}`;
        let headers = {};
        
        if (currentShareToken) {
            url += `?token=${currentShareToken}`;
        } else if (currentUser) {
            headers['X-User-UID'] = currentUser.uid;
        } else {
            return;
        }
        
        const response = await fetch(url, {
            method: 'DELETE',
            headers: headers
        });

        const result = await response.json();

        if (result.success) {
            if (currentShareToken) {
                await loadSharedFiles(currentPath);
            } else {
                await loadFiles(currentPath);
                loadStorageInfo();
            }
        } else {
            alert(result.error || 'Ошибка удаления');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Ошибка при удалении');
    }
};

// Скачивание - ИСПРАВЛЕНО
window.downloadFile = function (path, isShared = false, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    let url;
    
    if (isShared && currentShareToken) {
        url = `/api/download/${encodeURIComponent(path)}?token=${currentShareToken}`;
    } else if (currentUser) {
        url = `/api/download/${encodeURIComponent(path)}?uid=${currentUser.uid}`;
    } else {
        alert('Ошибка: не удалось определить пользователя');
        return;
    }
    
    window.location.href = url;
};

// Выход
window.logout = async function () {
    await auth.signOut();
    localStorage.removeItem('userUID');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('token');
    window.location.href = '/login';
};

// Загрузка информации о хранилище
async function loadStorageInfo() {
    if (!currentUser) return;

    try {
        const response = await fetch('/api/space', {
            headers: { 'X-User-UID': currentUser.uid }
        });
        const result = await response.json();

        if (result.success) {
            const data = result.data;
            document.getElementById('storageUsedBar').style.width = data.percent + '%';
            document.getElementById('storageText').innerHTML = `
                Использовано ${formatSize(data.used)} из 500 МБ (${data.percent.toFixed(1)}%)
            `;
        }
    } catch (error) {
        console.error('Ошибка загрузки информации о хранилище:', error);
    }
}

// Вспомогательные функции
function showLoading() {
    const tbody = document.getElementById('fileList');
    tbody.innerHTML = `
        <tr>
            <td colspan="5" class="loading">
                <i class="fas fa-spinner fa-spin"></i> Загрузка...
            </td>
        </tr>
    `;
}

function showError(message) {
    const tbody = document.getElementById('fileList');
    tbody.innerHTML = `
        <tr>
            <td colspan="5" class="loading" style="color: #e53e3e;">
                <i class="fas fa-exclamation-circle"></i> ${message}
            </td>
        </tr>
    `;
}

function showUploadProgress(current, total) {
    let progressBar = document.getElementById('uploadProgress');
    if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.id = 'uploadProgress';
        progressBar.className = 'upload-progress';
        progressBar.innerHTML = `
            <div class="progress-bar-container">
                <div class="progress-bar" id="uploadProgressBar" style="width: 0%"></div>
            </div>
            <div class="progress-info">
                <span>Загрузка...</span>
                <span id="uploadProgressText">0%</span>
            </div>
        `;
        document.body.appendChild(progressBar);
    }
    
    const percent = Math.round((current / total) * 100);
    document.getElementById('uploadProgressBar').style.width = percent + '%';
    document.getElementById('uploadProgressText').textContent = percent + '%';
    
    if (current === total) {
        setTimeout(() => {
            hideUploadProgress();
        }, 1000);
    }
}

function hideUploadProgress() {
    const progressBar = document.getElementById('uploadProgress');
    if (progressBar) {
        progressBar.remove();
    }
}

function getFileIcon(file) {
    if (file.isDir) return 'fa-folder';

    const ext = file.name.split('.').pop().toLowerCase();
    const icons = {
        'jpg': 'fa-file-image', 'jpeg': 'fa-file-image', 'png': 'fa-file-image', 'gif': 'fa-file-image',
        'pdf': 'fa-file-pdf',
        'doc': 'fa-file-word', 'docx': 'fa-file-word',
        'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel',
        'ppt': 'fa-file-powerpoint', 'pptx': 'fa-file-powerpoint',
        'txt': 'fa-file-alt',
        'mp3': 'fa-file-audio', 'wav': 'fa-file-audio',
        'mp4': 'fa-file-video', 'avi': 'fa-file-video', 'mov': 'fa-file-video',
        'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
        'html': 'fa-file-code', 'css': 'fa-file-code', 'js': 'fa-file-code', 'go': 'fa-file-code'
    };

    return icons[ext] || 'fa-file';
}

function getIconColor(file) {
    if (file.isDir) return '#5f6368';

    const colors = {
        'fa-file-image': '#34a853',
        'fa-file-pdf': '#d93025',
        'fa-file-word': '#1a73e8',
        'fa-file-excel': '#0f9d58',
        'fa-file-powerpoint': '#f9ab00',
        'fa-file-audio': '#c5221f',
        'fa-file-video': '#ea8600',
        'fa-file-archive': '#b3147c',
        'fa-file-code': '#1e8e3e',
        'fa-file-alt': '#5f6368'
    };

    const icon = getFileIcon(file);
    return colors[icon] || '#5f6368';
}

function formatSize(bytes) {
    if (bytes === 0) return '0 Б';

    const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));

    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

// Добавляем стили для прогресс-бара
const style = document.createElement('style');
style.textContent = `
    .upload-progress {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 300px;
        background: white;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        z-index: 1000;
        animation: slideIn 0.3s ease;
    }
    
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    .progress-bar-container {
        height: 8px;
        background: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
    }
    
    .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #667eea, #764ba2);
        transition: width 0.3s;
    }
    
    .progress-info {
        display: flex;
        justify-content: space-between;
        color: #666;
        font-size: 14px;
    }
`;
document.head.appendChild(style);