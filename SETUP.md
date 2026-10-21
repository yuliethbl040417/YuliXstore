# YuliXstore — backend de datos reales

Este backend guarda pedidos reales en PostgreSQL, inicia pagos por método seleccionado y procesa notificaciones de pago desde el servidor.

## Estado actual

- PostgreSQL para pedidos, pagos y productos.
- Creación de pedidos reales.
- Número de pedido único.
- Inicio de transacciones por método: tarjeta, Nequi, transferencia Bancolombia, QR Bancolombia, PSE y Daviplata.
- Registro de referencias y transacciones de pago.
- Login administrativo con contraseña hasheada.
- Registro e inicio de sesión de clientes con contraseña hasheada y JWT de 30 días.
- Historial de compras para clientes registrados.
- Panel API para productos y pedidos.
- Confirmación de pago mediante notificación firmada y validación de monto, moneda, referencia e ID de transacción.
- Estados separados para pago y recarga.
- Protección frente a notificaciones repetidas y validación del pago antes de entregar.
- Rate limiting básico.
- Entrega automática después de confirmar el pago, con bloqueo de procesamiento duplicado.

## Flujo de un pedido

1. El cliente selecciona un producto y un método de pago.
2. El backend calcula el total desde PostgreSQL y crea una referencia única.
3. El backend inicia una transacción con el método elegido. El navegador abre el flujo devuelto en una pestaña nueva; para Nequi, el cliente debe aceptar la notificación en la aplicación; para QR se muestra el código devuelto.
4. La notificación de pago se verifica en el backend. Solo se marca como aprobado si la firma es válida y coinciden la referencia, la moneda, el monto y el ID de transacción.
5. Tras confirmar el pago, el backend encola el envío a JADH para diamantes o a la ruta de productos especiales.
6. Los estados de entrega se guardan en PostgreSQL. Los pedidos no se reenvían si ya están en proceso o completados.

## Endpoints principales

### Clientes

- `POST /api/account/register`
- `POST /api/account/login`
- `GET /api/account/me`
- `GET /api/account/orders`

### Públicos

- `GET /api/health`
- `GET /api/products`
- `POST /api/orders`
- `GET /api/orders/:orderNumber`

### Administración

- `POST /api/admin/setup`
- `POST /api/admin/login`
- `GET /api/admin/products`
- `POST /api/admin/products`
- `PATCH /api/admin/products/:id`
- `DELETE /api/admin/products/:id`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:orderNumber/payment`
- `PATCH /api/admin/orders/:orderNumber/topup`\n- `POST /api/admin/orders/:orderNumber/retry-delivery`\n- `GET /api/admin/sixofire/items`

Para `/api/admin/*` se requiere `Authorization: Bearer <JWT>`.

## Integraciones internas

- JADH: diamantes normales. La integración existente se conserva; el envío automático posterior al pago usa la misma función de recarga.
- Sixofire: endpoint de catálogo y envío de pedidos de tienda. Los IDs de producto no se inventan; deben mapearse desde el catálogo autenticado antes de activar los productos especiales.
- Pagos: cada método crea una transacción distinta. Los datos privados solo viven en las variables de entorno del backend.

## Variables de entorno

Obligatorias para el backend:
- `DATABASE_URL`
- `JWT_SECRET`
- `FRONTEND_ORIGINS`

Recargas de diamantes:
- `JADH_API_KEY`
- `JADH_BASE_URL` (opcional)

Pagos:
- `WOMPI_ENV` (`sandbox` para pruebas; `production` solo después de validar)
- `WOMPI_PUBLIC_KEY`
- `WOMPI_PRIVATE_KEY`
- `WOMPI_INTEGRITY_SECRET`
- `WOMPI_EVENTS_SECRET`
- `STORE_PUBLIC_URL` (por ejemplo, el dominio público de la tienda)
- `WOMPI_API_BASE` (opcional; si no se define, depende de `WOMPI_ENV`)

Productos especiales:
- `SIXOFIRE_API_KEY`
- `SIXOFIRE_BASE_URL` (opcional, por defecto `https://api.sixofire.net`)
- `SIXOFIRE_PRODUCT_MAP`: JSON con los cinco IDs confirmados por la propietaria. Puedes copiar el JSON de una sola línea incluido en `RENDER_SIXOFIRE_PRODUCT_MAP.txt`. Los IDs son: Pase Booyah/correo `76828`, fragmento universal `17729`, caja universal `8816`, membresía semanal `8509`, membresía mensual `3752`.
- Para fragmentos y cajas se configura `supports_amount: true`, con límites de cantidad 35–1400 y 7–280 respectivamente, según las reglas de la tienda. Antes de activar ventas reales, confirma en el catálogo autenticado de SixoFire que ambos productos aceptan el campo `amount`.
- El envío de productos por correo se envía con `uid` y `product_id`, sin inventar un campo de correo ni añadir `message` (la documentación indica que `message` aplica solo a GIFT).
- En Render, crea/actualiza `SIXOFIRE_API_KEY` con la clave privada real y `SIXOFIRE_PRODUCT_MAP` con el contenido exacto del archivo. No pegues la clave privada en el repositorio, en el frontend ni en capturas.

No pongas claves privadas en el frontend, en un repositorio público, en capturas ni en chats.

## Instalación

1. Instala Node.js 20+ y PostgreSQL.
2. Configura las variables de entorno.
3. Ejecuta `npm install`.
4. Ejecuta `psql "$DATABASE_URL" -f schema.sql` si estás creando la base desde cero.
5. Ejecuta `npm start`.
6. Comprueba `GET /api/health`.
7. Publica el backend detrás de HTTPS.

El servidor también ejecuta `ensureSchema()` al iniciar para crear/migrar las tablas necesarias.

## Nota sobre la base existente

El `server.js` migra el esquema para registrar transacciones, productos especiales y notificaciones. Haz una copia de seguridad de la base de datos antes de desplegar esta versión sobre una base que ya tenga datos.

## Panel administrativo

El panel debe consumir:

- `POST /api/admin/login`
- `GET /api/admin/products`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:orderNumber/payment`
- `PATCH /api/admin/orders/:orderNumber/topup`\n- `POST /api/admin/orders/:orderNumber/retry-delivery`\n- `GET /api/admin/sixofire/items`

Así los pedidos y estados vienen de PostgreSQL y no de datos de demostración.

## Configuración del webhook de pagos

Configura en el panel de pagos la URL HTTPS:

`https://TU_BACKEND_PUBLICO/api/webhooks/wompi`

Suscríbela al evento `transaction.updated`. En Render, `WOMPI_EVENTS_SECRET` debe ser el secreto de eventos exacto entregado por la pasarela. El webhook verifica la firma antes de cambiar estados o iniciar entregas.

## Producción

Usa PostgreSQL administrado, HTTPS, copias de seguridad y variables de entorno protegidas.

## V6 — panel y seguridad
- `frontend/admin.html` es el panel privado de administración.
- Un pago confirmado por la notificación firmada inicia el envío de diamantes a JADH.
- El backend consulta automáticamente el estado de pedidos JADH en `PROCESSING` cada 60 segundos.
- El panel consulta estados de JADH y permite reintentar entregas fallidas de forma controlada.
- Los JWT de clientes no pueden acceder a rutas administrativas.
- Los pedidos asociados a una cuenta no se muestran a otra cuenta mediante la consulta pública.
- Mantén `JADH_API_KEY`, `DATABASE_URL` y `JWT_SECRET` únicamente en las variables de entorno del backend.


### Verificación de jugador
La tienda valida el ID de Free Fire antes de permitir continuar y muestra el nombre de la cuenta cuando el servicio de verificación responde correctamente. La validación se realiza desde el backend; nunca se marca un ID como verificado si la consulta falla. Se puede configurar `FREEFIRE_VERIFY_URL` en Render para usar un servicio de verificación compatible.

### Idioma
Los mensajes mostrados al cliente están en español, incluidos estados de pago y recarga en la consulta de pedidos.


## Checkout alojado en Wompi (sin formulario financiero en YuliXstore)

La tienda usa `POST /api/checkout/hosted` para registrar el pedido y redirigir al checkout alojado de Wompi. El cliente elige allí los medios de pago que Wompi tenga habilitados para la cuenta. Configura `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET` y `STORE_PUBLIC_URL` en Render; no coloques secretos en el frontend.

El webhook acepta tanto `/api/webhooks/wompi` como `/api/wompi/events` para conservar una URL ya configurada. Debe estar suscrito al evento `transaction.updated`. La aprobación del pago dispara la entrega para los pedidos que tengan una integración y un mapeo de proveedor válidos.

**Importante sobre “Compra ahora y paga después”:** el aviso al cliente está incorporado. Antes de activar esa modalidad en producción, confirma con Wompi cómo reporta el desembolso/liquidación para tu cuenta. Una transacción `APPROVED` no debe confundirse automáticamente con el dinero ya abonado en tu cuenta. Esta versión no puede verificar de forma independiente el abono bancario final. Si necesitas esperar específicamente al desembolso, mantén esa modalidad deshabilitada o deja esos pedidos en revisión hasta integrar una señal fiable de liquidación.
