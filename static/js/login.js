// ./js/auth.js  (или login.js)

let currentTab = 'login';

// Переключение вкладок (логин / регистрация)
window.switchTab = function(tab) {
    currentTab = tab;

    // Кнопки табов
    const loginTab = document.getElementById('loginTab');
    const registerTab = document.getElementById('registerTab');
    loginTab.classList.toggle('active', tab === 'login');
    registerTab.classList.toggle('active', tab === 'register');

    // Формы
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    loginForm.classList.toggle('active', tab === 'login');
    registerForm.classList.toggle('active', tab === 'register');
    loginForm.style.display = tab === 'login' ? 'block' : 'none';
    registerForm.style.display = tab === 'register' ? 'block' : 'none';

    hideError();
};

// Показать ошибку
function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    if (!errorDiv) return;
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';

    // Автоскрытие через 6 секунд
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 6000);
}

function hideError() {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) errorDiv.style.display = 'none';
}

// Управление состоянием загрузки кнопки
function setLoading(formType, isLoading) {
    const btn = document.getElementById(formType === 'login' ? 'loginBtn' : 'registerBtn');
    if (!btn) return;

    const span = btn.querySelector('span');
    const spinner = btn.querySelector('i.fa-spinner');

    btn.disabled = isLoading;
    if (span) span.style.opacity = isLoading ? '0.6' : '1';
    if (spinner) spinner.style.display = isLoading ? 'inline-block' : 'none';
}

// Вход
window.login = async function(event) {
    event.preventDefault();

    const email = document.getElementById('loginEmail')?.value?.trim();
    const password = document.getElementById('loginPassword')?.value;

    if (!email || !password) {
        showError('Введите email и пароль');
        return;
    }

    setLoading('login', true);
    hideError();

    try {
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        const user = userCredential.user;

        if (!user.emailVerified) {
            showError('Пожалуйста, подтвердите email. Проверьте почту (включая папку "Спам").');
            await firebase.auth().signOut();
            setLoading('login', false);
            return;
        }

        // Сохраняем данные
        localStorage.setItem('userUID', user.uid);
        localStorage.setItem('userEmail', user.email);

        // Получаем свежий токен
        const token = await user.getIdToken(true);
        localStorage.setItem('token', token);

        // Переход на главную
        window.location.href = '/index.html';  // или '/' — как у вас настроено

    } catch (error) {
        console.error('Ошибка входа:', error);

        let msg = 'Ошибка входа';

        switch (error.code) {
            case 'auth/invalid-email':
                msg = 'Неверный формат email';
                break;
            case 'auth/user-not-found':
            case 'auth/wrong-password':
            case 'auth/invalid-credential':
                msg = 'Неверный email или пароль';
                break;
            case 'auth/user-disabled':
                msg = 'Аккаунт заблокирован';
                break;
            case 'auth/too-many-requests':
                msg = 'Слишком много попыток. Попробуйте позже (через 5–30 минут)';
                break;
            default:
                msg = error.message || 'Неизвестная ошибка';
        }

        showError(msg);
        setLoading('login', false);
    }
};

// Регистрация
window.register = async function(event) {
    event.preventDefault();

    const name = document.getElementById('registerName')?.value?.trim();
    const email = document.getElementById('registerEmail')?.value?.trim();
    const password = document.getElementById('registerPassword')?.value;

    if (!name || !email || !password) {
        showError('Заполните все поля');
        return;
    }

    if (password.length < 6) {
        showError('Пароль должен содержать минимум 6 символов');
        return;
    }

    setLoading('register', true);
    hideError();

    try {
        const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // Устанавливаем displayName
        await user.updateProfile({ displayName: name });

        // Настройки письма верификации
        const actionCodeSettings = {
            url: window.location.origin + '/login.html',  // или '/'
            handleCodeInApp: false  // для обычной верификации обычно false
        };

        await user.sendEmailVerification(actionCodeSettings);

        // Показываем модалку
        document.getElementById('verifyModal')?.classList.add('show');

        // Выход после регистрации (чтобы не был залогинен без верификации)
        await firebase.auth().signOut();

    } catch (error) {
        console.error('Ошибка регистрации:', error);

        let msg = 'Ошибка регистрации';

        switch (error.code) {
            case 'auth/email-already-in-use':
                msg = 'Этот email уже зарегистрирован';
                break;
            case 'auth/invalid-email':
                msg = 'Неверный формат email';
                break;
            case 'auth/weak-password':
                msg = 'Пароль слишком слабый';
                break;
            default:
                msg = error.message || 'Неизвестная ошибка';
        }

        showError(msg);
        setLoading('register', false);
    }
}

// Автоматический редирект, если уже авторизован
firebase.auth().onAuthStateChanged(async (user) => {
    if (user) {
        if (user.emailVerified) {
            // Уже верифицирован → на главную
            localStorage.setItem('userUID', user.uid);
            localStorage.setItem('userEmail', user.email);
            const token = await user.getIdToken();
            localStorage.setItem('token', token);
            window.location.href = '/index.html';  // или '/'
        } else {
            // Не верифицирован → остаёмся на странице логина
            console.log('Email не подтверждён');
        }
    }
});

// Инициализация табов при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    // Делаем табы отзывчивыми на touch
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            const tabName = e.currentTarget.id === 'loginTab' ? 'login' : 'register';
            switchTab(tabName);
        });

        // Touch-обработка для мобильных
        tab.addEventListener('touchend', (e) => {
            e.preventDefault(); // предотвращаем двойной тап/зум
            const tabName = e.currentTarget.id === 'loginTab' ? 'login' : 'register';
            switchTab(tabName);
        });
    });

    // Автофокус на первое поле
    if (currentTab === 'login') {
        document.getElementById('loginEmail')?.focus();
    }
});
