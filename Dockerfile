# Usa una imagen oficial de Node.js con soporte para Chrome/Puppeteer
FROM ghcr.io/puppeteer/puppeteer:latest

# Cambiar a usuario root para instalar dependencias si es necesario
USER root

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencia
COPY package*.json ./

# Instalar dependencias del proyecto
RUN npm install

# Copiar el resto del código
COPY . .

# Exponer el puerto
EXPOSE 3001

# Variables de entorno por defecto (pueden ser sobreescritas en Render)
ENV NODE_ENV=production
ENV PORT=3001

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
