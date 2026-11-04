.PHONY: test build run
test:
	python -m unittest discover -s tests -v
build:
	npm --prefix frontend ci
	npm --prefix frontend run build
run:
	python app.py
