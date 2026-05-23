FROM nginx:alpine
COPY sahagroup-fair30-wheel.html /usr/share/nginx/html/index.html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
