// ./js/main.js

// Глобальные переменные
let currentPath = '/';
let userUID = null;

// Утилиты
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Создание строки таблицы (файл или папка)
function createFileRow(name, type, size, modified, fullPath) {
    const tr = document.createElement('tr');
    tr.dataset.path = fullPath;
    tr.dataset.type = type;

    const iconClass = type === 'folder' ? 'fa-folder' : 'fa-file';
    const iconColor = type === 'folder' ? 'var(--accent)' : 'var(--text-secondary)';

    tr.innerHTML = `
        <td style="width:40px; text-align:center;">
            <i class="fas ${iconClass}" style="color: ${iconColor}; font-size: 1.3rem;"></i>
        </td>
        <td style="font-weight: ${type === 'folder' ? '600' : '400'};">${name}</td>
        <td>${size}</td>
        <td>${modified}</td>
        <td style="width:120px; text-align:right;">
            ${type === 'file' ? `
                <button class="action-btn" onclick="downloadFile('${fullPath}')" title="Скачать">
                    <i class="fas fa-download"></i>
                </button>
            ` : ''}
            <button class="action-btn delete-btn" onclick="deleteItem('${fullPath}', '${type}')" title="Удалить">
                <i class="fas fa-trash-alt"></i>
            </button>
        </td>
    `;

    // Открытие папки по клику (и тач на мобильных)
    if (type === 'folder') {
        tr.style.cursor = 'pointer';

        const openFolder = () => {
            const cleanPath = fullPath
                .replace(`users/${userUID}/`, '')
                .replace(/\/$/, '') + '/';
            loadFiles(cleanPath);
        };

        // Для десктопа - клик
        tr.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return; // не открывать, если кликнули по кнопке
            openFolder();
        });

        // Для мобильки - тач
        let touchStartTime = 0;
        tr.addEventListener('touchstart', (e) => {
            touchStartTime = Date.now();
            tr.classList.add('touch-active');
        });

        tr.addEventListener('touchend', (e) => {
            tr.classList.remove('touch-active');
            if (Date.now() - touchStartTime < 500 && !e.target.closest('.action-btn')) { // короткий тап
                openFolder();
            }
        });

        tr.addEventListener('touchcancel', () => {
            tr.classList.remove('touch-active');
        });
    }

    return tr;
}

// Загрузка содержимого текущей папки
async function loadFiles(path = '/') {
    currentPath = path;
    const fileList = document.getElementById('fileList');
    const breadcrumbElement = document.getElementById('breadcrumb');

    if (!fileList) return;

    fileList.innerHTML = `
        <tr>
            <td colspan="5" class="loading">
                <i class="fas fa-spinner fa-spin"></i> Загрузка защищённого хранилища...
            </td>
        </tr>
    `;

    try {
        const user = firebase.auth().currentUser;
        if (!user) throw new Error('Пользователь не авторизован');

        userUID = user.uid;
        const storage = firebase.storage();
        const listRef = storage.ref(`users/${user.uid}${path}`);

        const res = await listRef.listAll();

        fileList.innerHTML = '';

        // Папки
        for (const prefix of res.prefixes) {
            const name = prefix.name.split('/').pop(); // исправление: правильное имя папки
            const fullPath = prefix.fullPath;
            const row = createFileRow(name, 'folder', '—', '—', fullPath);
            fileList.appendChild(row);
        }

        // Файлы
        for (const itemRef of res.items) {
            const metadata = await itemRef.getMetadata();
            const name = itemRef.name;
            const size = formatSize(metadata.size);
            const modified = formatDate(metadata.updated);
            const fullPath = itemRef.fullPath;

            const row = createFileRow(name, 'file', size, modified, fullPath);
            fileList.appendChild(row);
        }

        if (res.prefixes.length === 0 && res.items.length === 0) {
            fileList.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:4rem 0; color:var(--text-secondary);">
                        Папка пуста
                    </td>
                </tr>
            `;
        }

        updateBreadcrumb(path);
        updateStorageUsage();

    } catch (error) {
        console.error('Ошибка загрузки файлов:', error);
        fileList.innerHTML = `
            <tr>
                <td colspan="5" style="color:#fca5a5; text-align:center; padding:3rem;">
                    Ошибка: ${error.message}
                </td>
            </tr>
        `;
    }
}

// Обновление хлебных крошек
function updateBreadcrumb(path) {
    const breadcrumb = document.getElementById('breadcrumb');
    if (!breadcrumb) return;

    breadcrumb.innerHTML = '';

    const parts = path.split('/').filter(Boolean);
    let accumulatedPath = '/';

    // Корень
    const rootLink = document.createElement('a');
    rootLink.href = '#';
    rootLink.textContent = 'Мой диск';
    rootLink.onclick = (e) => {
        e.preventDefault();
        loadFiles('/');
    };
    breadcrumb.appendChild(rootLink);

    parts.forEach((part, index) => {
        accumulatedPath += part + '/';

        const separator = document.createElement('span');
        separator.textContent = ' / ';
        separator.style.color = 'var(--text-secondary)';
        breadcrumb.appendChild(separator);

        const link = document.createElement('a');
        link.href = '#';
        link.textContent = part;
        link.onclick = (e) => {
            e.preventDefault();
            loadFiles(accumulatedPath);
        };
        breadcrumb.appendChild(link);
    });
}

// Обновление информации о занятом месте
async function updateStorageUsage() {
    const bar = document.getElementById('storageUsedBar');
    const text = document.getElementById('storageText');

    if (!bar || !text) return;

    try {
        const storage = firebase.storage();
        const rootRef = storage.ref(`users/${userUID}`);
        const res = await rootRef.listAll();
        
        let totalSize = 0;
        
        // Рекурсивный подсчёт размера
        async function calculateSize(items, prefixes) {
            for (const item of items) {
                const meta = await item.getMetadata();
                totalSize += meta.size;
            }
            for (const prefix of prefixes) {
                const subRes = await prefix.listAll();
                await calculateSize(subRes.items, subRes.prefixes);
            }
        }
        
        await calculateSize(res.items, res.prefixes);
        
        // Предполагаем квоту 5GB бесплатно
        const quota = 5 * 1024 * 1024 * 1024; // 5GB
        const usedPercent = Math.min((totalSize / quota) * 100, 100);
        
        bar.style.width = `${usedPercent}%`;
        text.textContent = `${formatSize(totalSize)} / ${formatSize(quota)} использовано`;
    } catch (err) {
        console.error('Ошибка подсчёта хранилища:', err);
        text.textContent = '—';
    }
}

// Скачивание файла
async function downloadFile(fullPath) {
    try {
        const storage = firebase.storage();
        const url = await storage.ref(fullPath).getDownloadURL();
        const a = document.createElement('a');
        a.href = url;
        a.download = fullPath.split('/').pop();
        a.click();
    } catch (err) {
        console.error('Ошибка скачивания:', err);
        alert('Не удалось скачать файл');
    }
}

// Удаление файла или папки (рекурсивно для папок, исправление: полная очистка)
async function deleteItem(fullPath, type) {
    if (!confirm(`Вы действительно хотите удалить ${type === 'folder' ? 'папку и всё содержимое' : 'файл'}?\nЭто действие нельзя отменить.`)) {
        return;
    }

    try {
        const storage = firebase.storage();
        const ref = storage.ref(fullPath);

        if (type === 'file') {
            await ref.delete();
        } else {
            // Рекурсивное удаление содержимого папки
            const list = await ref.listAll();

            // Удаляем файлы
            await Promise.all(list.items.map(item => item.delete()));

            // Удаляем подпапки (рекурсия)
            await Promise.all(list.prefixes.map(prefix => deleteItem(prefix.fullPath, 'folder')));

            // Поскольку папки виртуальные, удаление содержимого достаточно, но для очистки .keep
            // Проверяем, остался ли .keep или другие файлы
            const checkEmpty = await ref.listAll();
            if (checkEmpty.items.length > 0) {
                await Promise.all(checkEmpty.items.map(item => item.delete()));
            }
        }

        // Обновляем список
        loadFiles(currentPath);
    } catch (err) {
        console.error('Ошибка удаления:', err);
        alert('Не удалось удалить: ' + err.message);
    }
}

// Создание папки (исправление: уникальное имя, проверка существования)
function createFolder() {
    document.getElementById('folderModal').classList.add('show');
    document.getElementById('folderName').value = '';
    document.getElementById('folderName').focus();
}

function closeFolderModal() {
    document.getElementById('folderModal').classList.remove('show');
}

async function createFolderConfirm() {
    const name = document.getElementById('folderName').value.trim();
    if (!name) {
        alert('Введите имя папки');
        return;
    }

    try {
        const storage = firebase.storage();
        const folderRef = storage.ref(`users/${userUID}${currentPath}${name}/`);

        // Проверка на существование (listAll для префикса)
        const existing = await folderRef.list({ maxResults: 1 });
        if (existing.prefixes.length > 0 || existing.items.length > 0) {
            alert('Папка с таким именем уже существует');
            return;
        }

        // Создаём фиктивный файл .keep
        const dummyRef = storage.ref(`users/${userUID}${currentPath}${name}/.keep`);
        await dummyRef.putString('placeholder');

        closeFolderModal();
        loadFiles(currentPath);
    } catch (err) {
        console.error('Ошибка создания папки:', err);
        alert('Не удалось создать папку: ' + err.message);
    }
}

// Загрузка файлов (с прогрессом на мобилке)
function triggerFileUpload() {
    document.getElementById('fileInput').click();
}

async function uploadFiles(files) {
    if (!files || files.length === 0) return;

    const user = firebase.auth().currentUser;
    if (!user) return;

    const storage = firebase.storage();

    for (const file of files) {
        try {
            const storageRef = storage.ref(`users/${user.uid}${currentPath}${file.name}`);
            
            // Проверка на существование
            try {
                await storageRef.getMetadata();
                if (!confirm(`Файл ${file.name} уже существует. Перезаписать?`)) continue;
            } catch (err) {
                if (err.code !== 'storage/object-not-found') throw err;
            }
            
            const uploadTask = storageRef.put(file);
            
            // Прогресс (можно показать в UI, для мобилки - toast или бар)
            uploadTask.on('state_changed', 
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    console.log(`Загрузка ${file.name}: ${progress}%`);
                    // Здесь можно обновить UI прогресс бар
                },
                (err) => console.error(err),
                () => console.log(`Загружен ${file.name}`)
            );
            
            await uploadTask;
        } catch (err) {
            console.error(`Ошибка загрузки ${file.name}:`, err);
            alert(`Не удалось загрузить ${file.name}`);
        }
    }

    loadFiles(currentPath);
}

// Drag & Drop с поддержкой touch (polyfill для мобильки)
function initDragAndDrop() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

    // Десктоп drag
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('active');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('active');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');
        const files = e.dataTransfer?.files || [];
        uploadFiles(files);
    });

    // Touch для мобильки (симуляция drag & drop)
    let touchFiles = [];
    document.addEventListener('touchstart', (e) => {
        touchFiles = []; // сброс
    });

    dropZone.addEventListener('touchmove', (e) => {
        e.preventDefault(); // предотвратить скролл
        dropZone.classList.add('active');
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
    }, { passive: false });

    dropZone.addEventListener('touchend', (e) => {
        dropZone.classList.remove('active');
        const files = touchFiles.length > 0 ? touchFiles : (e.dataTransfer?.files || []);
        if (files.length > 0) {
            uploadFiles(files);
        }
        touchFiles = [];
    });

    // Для выбора файлов на тач
    dropZone.addEventListener('click', triggerFileUpload);
}

// Мобильное меню с touch
function toggleMobileMenu() {
    document.getElementById('sidebar').classList.toggle('active');
    document.getElementById('mobileMenuOverlay').classList.toggle('active');
}

function closeMobileMenu() {
    document.getElementById('sidebar').classList.remove('active');
    document.getElementById('mobileMenuOverlay').classList.remove('active');
}

// Инициализация после авторизации
firebase.auth().onAuthStateChanged(async (user) => {
    if (user) {
        document.getElementById('authCheck').style.display = 'none';
        document.getElementById('app').style.display = 'flex';

        document.getElementById('userName').textContent = user.displayName || user.email.split('@')[0];
        document.getElementById('userEmail').textContent = user.email;

        initDragAndDrop();
        document.getElementById('fileInput').addEventListener('change', (e) => uploadFiles(e.target.files));
        await loadFiles('/');
    } else {
        window.location.href = '/login.html';
    }
});

// Обработчики кнопок
document.addEventListener('DOMContentLoaded', () => {
    const newBtn = document.getElementById('newBtn');
    const newMenu = document.getElementById('newMenu');

    if (newBtn && newMenu) {
        newBtn.addEventListener('click', () => {
            newMenu.style.display = newMenu.style.display === 'block' ? 'none' : 'block';
        });
        newBtn.addEventListener('touchend', () => {
            newMenu.style.display = newMenu.style.display === 'block' ? 'none' : 'block';
        });
    }

    // Закрытие меню "Создать" при клике/таче вне
    document.addEventListener('click', (e) => {
        if (!newBtn?.contains(e.target) && !newMenu?.contains(e.target)) {
            if (newMenu) newMenu.style.display = 'none';
        }
    });
    document.addEventListener('touchend', (e) => {
        if (!newBtn?.contains(e.target) && !newMenu?.contains(e.target)) {
            if (newMenu) newMenu.style.display = 'none';
        }
    });

    // Swipe для закрытия sidebar на мобилке
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        let touchStartX = 0;
        sidebar.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
        });
        sidebar.addEventListener('touchmove', (e) => {
            const touchX = e.touches[0].clientX;
            if (touchX < touchStartX - 50) { // swipe left
                closeMobileMenu();
            }
        });
    }
});

// Экспорт функций в глобальную область (для onclick в HTML)
window.loadFiles = loadFiles;
window.createFolder = createFolder;
window.closeFolderModal = closeFolderModal;
window.createFolderConfirm = createFolderConfirm;
window.triggerFileUpload = triggerFileUpload;
window.logout = () => firebase.auth().signOut();
window.toggleMobileMenu = toggleMobileMenu;
window.closeMobileMenu = closeMobileMenu;
